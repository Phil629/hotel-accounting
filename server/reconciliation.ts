import { PrismaClient, Invoice, BankTransaction, BookingPayment, CardPayment } from '@prisma/client';

const prisma = new PrismaClient();

const DATE_TOLERANCE_DAYS = 5; // Standard tolerance (Nexi, etc.)
const BANK_DATE_TOLERANCE_DAYS = 60; // Bank transfer tolerance (2 months)
const AMOUNT_TOLERANCE = 0.01;

export async function runReconciliation() {
    console.log("Starting reconciliation...");
    let matchCount = 0;

    // 1. Get unreconciled invoices
    const invoices = await prisma.invoice.findMany({
        where: { isReconciled: false }
    });

    console.log(`Found ${invoices.length} unreconciled invoices.`);

    for (const invoice of invoices) {
        let matchFound = false;

        // A. Booking.com
        if (invoice.paymentType.toLowerCase().includes('booking.com')) {
            matchFound = await matchBooking(invoice);
        }
        // B. Nexi (Card)
        else if (isCardPayment(invoice.paymentType)) {
            matchFound = await matchNexi(invoice);
        }
        // C. Bank Transfer
        else if (invoice.paymentType.toLowerCase().includes('bank')) {
            matchFound = await matchBank(invoice);
        }

        if (matchFound) {
            matchCount++;
            await prisma.invoice.update({
                where: { id: invoice.id },
                data: { isReconciled: true, reconciledDate: new Date() }
            });
        }
    }

    console.log(`Reconciliation complete. Matched ${matchCount} invoices.`);
    return { matches: matchCount };
}

// --- Matchers ---

async function matchBooking(invoice: Invoice): Promise<boolean> {
    // 1. Try exact amount match with wider date tolerance
    const minAmount = invoice.amount - AMOUNT_TOLERANCE;
    const maxAmount = invoice.amount + AMOUNT_TOLERANCE;

    // Tolerance for Booking (check-in to payout window)
    const BOOKING_DATE_TOLERANCE = 5;

    const candidates = await prisma.bookingPayment.findMany({
        where: {
            amount: { gte: minAmount, lte: maxAmount }
        },
        include: { matches: true }
    });

    console.log(`\n=== Matching Booking.com for Invoice #${invoice.invoiceNumber} ===`);
    console.log(`Invoice: ${invoice.recipient}, Amount: ${invoice.amount}, Date: ${invoice.invoiceDate.toISOString().split('T')[0]}`);
    console.log(`Found ${candidates.length} Booking.com payment candidates with matching amount`);

    for (const payment of candidates) {
        if (payment.matches.length > 0) {
            console.log(`  - Skipping payment ${payment.referenceNumber} (already matched)`);
            continue;
        }

        // Check if invoice date falls within the booking period (check-in to payout + tolerance)
        const invoiceTime = invoice.invoiceDate.getTime();
        const checkInTime = payment.checkInDate.getTime() - (BOOKING_DATE_TOLERANCE * 24 * 60 * 60 * 1000);
        const payoutTime = payment.payoutDate.getTime() + (BOOKING_DATE_TOLERANCE * 24 * 60 * 60 * 1000);

        // Also check if Reference Number is found in Invoice Recipient/Comment
        const refMatch = invoice.recipient.includes(payment.referenceNumber) ||
            (invoice.comment && invoice.comment.includes(payment.referenceNumber));

        const dateMatch = invoiceTime >= checkInTime && invoiceTime <= payoutTime;

        console.log(`  - Payment ${payment.referenceNumber}: Amount=${payment.amount}, CheckIn=${payment.checkInDate.toISOString().split('T')[0]}, Payout=${payment.payoutDate.toISOString().split('T')[0]}`);
        console.log(`    Date match: ${dateMatch}, Ref match: ${refMatch}`);

        if (dateMatch || refMatch) {
            console.log(`    ✓ MATCH FOUND!`);
            await prisma.reconciliationMatch.create({
                data: {
                    invoiceId: invoice.id,
                    bookingPaymentId: payment.id,
                    matchType: refMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                    confidence: refMatch ? 1.0 : 0.85
                }
            });
            return true;
        }
    }
    console.log(`  ✗ No match found for this invoice`);
    return false;
}

async function matchNexi(invoice: Invoice): Promise<boolean> {
    const minAmount = invoice.amount - AMOUNT_TOLERANCE;
    const maxAmount = invoice.amount + AMOUNT_TOLERANCE;

    const candidates = await prisma.cardPayment.findMany({
        where: {
            amount: { gte: minAmount, lte: maxAmount }
        },
        include: { matches: true }
    });

    for (const payment of candidates) {
        if (payment.matches.length > 0) continue;

        const diffDays = Math.abs(differenceInDays(invoice.invoiceDate, payment.transactionDate));

        if (diffDays <= DATE_TOLERANCE_DAYS) {
            await prisma.reconciliationMatch.create({
                data: {
                    invoiceId: invoice.id,
                    cardPaymentId: payment.id,
                    matchType: 'AUTOMATIC',
                    confidence: 0.9
                }
            });
            return true;
        }
    }
    return false;
}

async function matchBank(invoice: Invoice): Promise<boolean> {
    const minAmount = invoice.amount - AMOUNT_TOLERANCE;
    const maxAmount = invoice.amount + AMOUNT_TOLERANCE;

    const candidates = await prisma.bankTransaction.findMany({
        where: {
            amount: { gte: minAmount, lte: maxAmount }
        },
        include: { matches: true }
    });

    for (const payment of candidates) {
        if (payment.matches.length > 0) continue;

        const diffDays = Math.abs(differenceInDays(invoice.invoiceDate, payment.bookingDate));

        // 1. Check Name Match
        const nameMatch = payment.senderReceiver && invoice.recipient &&
            (payment.senderReceiver.toLowerCase().includes(invoice.recipient.toLowerCase()) ||
                invoice.recipient.toLowerCase().includes(payment.senderReceiver.toLowerCase()));

        // 2. Check Invoice Number Match in Description
        const invoiceNum = extractInvoiceNumber(invoice.invoiceNumber);
        const descMatch = invoiceNum && payment.description && payment.description.includes(invoiceNum);

        // Match if:
        // (Date OK AND Name OK) OR (Date OK AND Invoice Number OK)
        // We use the same date tolerance for both, but invoice number match is stronger

        if (diffDays <= BANK_DATE_TOLERANCE_DAYS) {
            if (nameMatch || descMatch) {
                await prisma.reconciliationMatch.create({
                    data: {
                        invoiceId: invoice.id,
                        bankTransactionId: payment.id,
                        matchType: descMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                        confidence: descMatch ? 1.0 : 0.8
                    }
                });
                return true;
            }
        }
    }
    return false;
}

// --- Helpers ---

function differenceInDays(d1: Date, d2: Date): number {
    const oneDay = 24 * 60 * 60 * 1000;
    return Math.round((d1.getTime() - d2.getTime()) / oneDay);
}

function isCardPayment(type: string): boolean {
    const t = type.toLowerCase();
    return t.includes('ec-karte') || t.includes('visa') || t.includes('mastercard') || t.includes('maestro') || t.includes('visa electron');
}

function extractInvoiceNumber(fullNumber: string): string | null {
    // Extracts "18800" from "Rechnung 18800" or just returns "18800"
    if (!fullNumber) return null;
    const match = fullNumber.match(/(\d+)/);
    return match ? match[0] : null;
}
