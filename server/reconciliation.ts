import { PrismaClient, Invoice, BankTransaction, BookingPayment, CardPayment } from '@prisma/client';

const prisma = new PrismaClient();

const DATE_TOLERANCE_DAYS = 5; // Standard tolerance (Nexi, etc.)
const BANK_DATE_TOLERANCE_DAYS = 60; // Bank transfer tolerance (2 months)
const AMOUNT_TOLERANCE = 0.01;

type BookingWithMatches = BookingPayment & { matches: { id: number }[] };
type CardWithMatches = CardPayment & { matches: { id: number }[] };
type BankWithMatches = BankTransaction & { matches: { id: number }[] };

export async function runReconciliation() {
    console.log("Starting reconciliation...");

    // 1. Load ALL data in a single batch (instead of per-invoice queries)
    // Only load payments from last 9 months to keep memory usage low
    const nineMonthsAgo = new Date();
    nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);

    const [invoices, bookingPayments, cardPayments, bankTransactions] = await Promise.all([
        prisma.invoice.findMany({ where: { isReconciled: false } }),
        prisma.bookingPayment.findMany({
            where: { checkInDate: { gte: nineMonthsAgo } },
            include: { matches: { select: { id: true } } }
        }),
        prisma.cardPayment.findMany({
            where: { transactionDate: { gte: nineMonthsAgo } },
            include: { matches: { select: { id: true } } }
        }),
        prisma.bankTransaction.findMany({
            where: { bookingDate: { gte: nineMonthsAgo } },
            include: { matches: { select: { id: true } } }
        })
    ]);

    console.log(`Loaded: ${invoices.length} unreconciled invoices, ${bookingPayments.length} booking payments, ${cardPayments.length} card payments, ${bankTransactions.length} bank transactions`);

    // 2. Index payments by amount range for fast lookup
    const availableBookings = bookingPayments.filter(p => p.matches.length === 0);
    const availableCards = cardPayments.filter(p => p.matches.length === 0);
    const availableBanks = bankTransactions.filter(p => p.matches.length === 0);

    // Track which payments we've already matched in this run (to avoid double-matching)
    const matchedBookingIds = new Set<number>();
    const matchedCardIds = new Set<number>();
    const matchedBankIds = new Set<number>();

    // 3. Match in memory — collect all results
    const matchesToCreate: any[] = [];
    const invoiceIdsToReconcile: number[] = [];

    for (const invoice of invoices) {
        let matchFound = false;

        // A. Booking.com
        if (invoice.paymentType.toLowerCase().includes('booking.com')) {
            matchFound = matchBookingInMemory(invoice, availableBookings, matchedBookingIds, matchesToCreate);
        }
        // B. Nexi (Card)
        else if (isCardPayment(invoice.paymentType)) {
            matchFound = matchNexiInMemory(invoice, availableCards, matchedCardIds, matchesToCreate);
        }
        // C. Bank Transfer
        else if (invoice.paymentType.toLowerCase().includes('bank')) {
            matchFound = matchBankInMemory(invoice, availableBanks, matchedBankIds, matchesToCreate);
        }

        if (matchFound) {
            invoiceIdsToReconcile.push(invoice.id);
        }
    }

    // 4. Write all results in a single transaction
    if (matchesToCreate.length > 0) {
        await prisma.$transaction([
            prisma.reconciliationMatch.createMany({ data: matchesToCreate }),
            ...invoiceIdsToReconcile.map(id =>
                prisma.invoice.update({
                    where: { id },
                    data: { isReconciled: true, reconciledDate: new Date() }
                })
            )
        ]);
    }

    console.log(`Reconciliation complete. Matched ${invoiceIdsToReconcile.length} invoices.`);
    return { matches: invoiceIdsToReconcile.length };
}

// --- In-Memory Matchers ---

function matchBookingInMemory(
    invoice: Invoice,
    payments: BookingWithMatches[],
    matchedIds: Set<number>,
    results: any[]
): boolean {
    const BOOKING_DATE_TOLERANCE = 5;

    for (const payment of payments) {
        if (matchedIds.has(payment.id)) continue;

        // Amount check
        if (Math.abs(payment.amount - invoice.amount) > AMOUNT_TOLERANCE) continue;

        // Date check: invoice date within check-in to payout window ± tolerance
        const invoiceTime = invoice.invoiceDate.getTime();
        const checkInTime = payment.checkInDate.getTime() - (BOOKING_DATE_TOLERANCE * 24 * 60 * 60 * 1000);
        const payoutTime = payment.payoutDate.getTime() + (BOOKING_DATE_TOLERANCE * 24 * 60 * 60 * 1000);

        const refMatch = invoice.recipient.includes(payment.referenceNumber) ||
            (invoice.comment && invoice.comment.includes(payment.referenceNumber));

        const dateMatch = invoiceTime >= checkInTime && invoiceTime <= payoutTime;

        if (dateMatch || refMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId: invoice.id,
                bookingPaymentId: payment.id,
                matchType: refMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                confidence: refMatch ? 1.0 : 0.85
            });
            return true;
        }
    }
    return false;
}

function matchNexiInMemory(
    invoice: Invoice,
    payments: CardWithMatches[],
    matchedIds: Set<number>,
    results: any[]
): boolean {
    for (const payment of payments) {
        if (matchedIds.has(payment.id)) continue;

        if (Math.abs(payment.amount - invoice.amount) > AMOUNT_TOLERANCE) continue;

        const diffDays = Math.abs(differenceInDays(invoice.invoiceDate, payment.transactionDate));
        if (diffDays <= DATE_TOLERANCE_DAYS) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId: invoice.id,
                cardPaymentId: payment.id,
                matchType: 'AUTOMATIC',
                confidence: 0.9
            });
            return true;
        }
    }
    return false;
}

function matchBankInMemory(
    invoice: Invoice,
    payments: BankWithMatches[],
    matchedIds: Set<number>,
    results: any[]
): boolean {
    for (const payment of payments) {
        if (matchedIds.has(payment.id)) continue;

        if (Math.abs(payment.amount - invoice.amount) > AMOUNT_TOLERANCE) continue;

        const diffDays = Math.abs(differenceInDays(invoice.invoiceDate, payment.bookingDate));

        if (diffDays <= BANK_DATE_TOLERANCE_DAYS) {
            const nameMatch = payment.senderReceiver && invoice.recipient &&
                (payment.senderReceiver.toLowerCase().includes(invoice.recipient.toLowerCase()) ||
                    invoice.recipient.toLowerCase().includes(payment.senderReceiver.toLowerCase()));

            const invoiceNum = extractInvoiceNumber(invoice.invoiceNumber);
            const descMatch = invoiceNum && payment.description && payment.description.includes(invoiceNum);

            if (nameMatch || descMatch) {
                matchedIds.add(payment.id);
                results.push({
                    invoiceId: invoice.id,
                    bankTransactionId: payment.id,
                    matchType: descMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                    confidence: descMatch ? 1.0 : 0.8
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
    if (!fullNumber) return null;
    const match = fullNumber.match(/(\d+)/);
    return match ? match[0] : null;
}
