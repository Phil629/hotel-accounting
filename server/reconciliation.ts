import { Invoice, BankTransaction, BookingPayment, CardPayment, Prisma } from '@prisma/client';
import prisma from './db';

const DATE_TOLERANCE_DAYS      = 5;    // Nexi / card: days between invoice and transaction
const BANK_DATE_TOLERANCE_DAYS = 60;   // Bank transfers: up to 2 months delay
const BOOKING_DATE_TOLERANCE   = 5;    // Slack around check-in / payout window
const AMOUNT_TOLERANCE_CENTS   = 1;    // ±0.01 € — Booking.com pays exact gross amounts

type BookingWithMatches = BookingPayment  & { matches: { id: number }[] };
type CardWithMatches    = CardPayment     & { matches: { id: number }[] };
type BankWithMatches    = BankTransaction & { matches: { id: number }[] };
type MatchRecord        = Prisma.ReconciliationMatchCreateManyInput;

// ─── Amount Index ─────────────────────────────────────────────────────────────

/**
 * Converts a Decimal or float amount to integer cents.
 * Working in integer cents eliminates float comparison noise throughout.
 */
function toCents(amount: Prisma.Decimal | number): number {
    return Math.round(Number(amount) * 100);
}

/**
 * Builds a Map<cents, Payment[]> keyed by integer-cent amount (#3).
 *
 * Before this change the matchers used a nested for-loop: for each of the N
 * invoices, all M available payments were scanned → O(N×M). At 1 000 invoices
 * and 1 000 payments that is 1 000 000 comparisons; at 5 000 × 5 000 it is
 * 25 000 000 and the reconciliation endpoint freezes the Node.js process.
 *
 * With this index the build cost is O(M) and each invoice lookup is O(1)
 * (one Map.get per ±1-cent bucket), reducing the total to O(N + M).
 */
function buildAmountIndex<T extends { amount: Prisma.Decimal }>(payments: T[]): Map<number, T[]> {
    const index = new Map<number, T[]>();
    for (const p of payments) {
        const cents = toCents(p.amount);
        const bucket = index.get(cents);
        if (bucket) bucket.push(p);
        else index.set(cents, [p]);
    }
    return index;
}

/**
 * Returns all payments whose amount is within ±1 cent of the invoice amount.
 * The 1-cent window absorbs any Decimal ↔ float representation noise while
 * keeping the candidate set tiny (typically 0–2 entries).
 */
function getCandidates<T>(index: Map<number, T[]>, invoiceCents: number): T[] {
    const lo = index.get(invoiceCents - AMOUNT_TOLERANCE_CENTS) ?? [];
    const mid = index.get(invoiceCents)                          ?? [];
    const hi = index.get(invoiceCents + AMOUNT_TOLERANCE_CENTS) ?? [];
    // Fast path: avoid array spread when only the mid bucket is populated
    if (lo.length === 0 && hi.length === 0) return mid;
    return [...lo, ...mid, ...hi];
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

/**
 * Day difference using UTC midnight normalisation.
 *
 * The naive approach — (d1.getTime() - d2.getTime()) / 86_400_000 — produces
 * wrong results when one date was constructed via `new Date(year, month, day)`
 * (local midnight) and the other comes from a DB timestamp stored as UTC
 * midnight. In CET (UTC+1) the two midnights are 1 hour apart, causing a
 * fractional difference that rounds to ±1 day.
 * Using Date.UTC(y, m, d) for both operands eliminates the timezone offset
 * before the subtraction.
 */
function differenceInDays(d1: Date, d2: Date): number {
    const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
    const utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
    return Math.round((utc1 - utc2) / 86_400_000);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runReconciliation() {
    console.log('Starting reconciliation...');

    const nineMonthsAgo = new Date();
    nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);

    const [invoices, bookingPayments, cardPayments, bankTransactions] = await Promise.all([
        prisma.invoice.findMany({
            where: { isReconciled: false },
        }),
        prisma.bookingPayment.findMany({
            // Filter by createdAt, not checkInDate — checkInDate is nullable since
            // not every Booking.com export includes it.
            where:   { createdAt: { gte: nineMonthsAgo } },
            include: { matches: { select: { id: true } } },
        }),
        prisma.cardPayment.findMany({
            where:   { transactionDate: { gte: nineMonthsAgo } },
            include: { matches: { select: { id: true } } },
        }),
        prisma.bankTransaction.findMany({
            where:   { bookingDate: { gte: nineMonthsAgo } },
            include: { matches: { select: { id: true } } },
        }),
    ]);

    console.log(
        `Loaded: ${invoices.length} open invoices | ` +
        `${bookingPayments.length} booking | ${cardPayments.length} card | ${bankTransactions.length} bank`,
    );

    // Exclude payments that were already matched in a previous run
    const availableBookings = bookingPayments.filter(p => p.matches.length === 0);
    const availableCards    = cardPayments.filter(p => p.matches.length === 0);
    const availableBanks    = bankTransactions.filter(p => p.matches.length === 0);

    // Build indexes — O(M) one-time cost, then O(1) per invoice lookup (#3)
    const bookingIndex = buildAmountIndex(availableBookings);
    const cardIndex    = buildAmountIndex(availableCards);
    const bankIndex    = buildAmountIndex(availableBanks);

    // Sets prevent double-matching within a single reconciliation run
    const matchedBookingIds = new Set<number>();
    const matchedCardIds    = new Set<number>();
    const matchedBankIds    = new Set<number>();

    const matchesToCreate: MatchRecord[] = [];
    const invoiceIdsToReconcile: number[] = [];
    const matchedInvoiceIds = new Set<number>();
    const invoicesWithSuggestions = new Set<number>();

    for (let pass = 1; pass <= 4; pass++) {
        for (const invoice of invoices) {
            if (matchedInvoiceIds.has(invoice.id) || invoicesWithSuggestions.has(invoice.id)) {
                continue;
            }

            const cents = toCents(invoice.amount);
            let result: 'NONE' | 'AUTOMATIC' | 'SUGGESTED_MISMATCH' = 'NONE';

            if (invoice.paymentType.toLowerCase().includes('booking.com')) {
                result = matchBooking(invoice, cents, bookingIndex, matchedBookingIds, matchesToCreate, pass);
            } else if (isCardPayment(invoice.paymentType)) {
                result = matchCard(invoice, cents, cardIndex, matchedCardIds, matchesToCreate, pass);
            } else if (invoice.paymentType.toLowerCase().includes('bank')) {
                result = matchBank(invoice, cents, bankIndex, matchedBankIds, matchesToCreate, pass);
            }

            if (result === 'AUTOMATIC') {
                matchedInvoiceIds.add(invoice.id);
                invoiceIdsToReconcile.push(invoice.id);
            } else if (result === 'SUGGESTED_MISMATCH') {
                invoicesWithSuggestions.add(invoice.id);
                // We do NOT add to invoiceIdsToReconcile because it needs manual approval!
            }
        }
    }

    if (matchesToCreate.length > 0) {
        await prisma.$transaction([
            prisma.reconciliationMatch.createMany({ data: matchesToCreate }),
            ...invoiceIdsToReconcile.map(id =>
                prisma.invoice.update({
                    where: { id },
                    data:  { isReconciled: true, reconciledDate: new Date() },
                }),
            ),
        ]);
    }

    console.log(`Reconciliation complete. ${invoiceIdsToReconcile.length} invoices matched.`);
    return { matches: invoiceIdsToReconcile.length };
}

// ─── Matchers ─────────────────────────────────────────────────────────────────

function matchBooking(
    invoice: Invoice,
    invoiceCents: number,
    index: Map<number, BookingWithMatches[]>,
    matchedIds: Set<number>,
    results: MatchRecord[],
    pass: number
): 'NONE' | 'AUTOMATIC' | 'SUGGESTED_MISMATCH' {
    for (const payment of getCandidates(index, invoiceCents)) {
        if (matchedIds.has(payment.id)) continue;

        // Reference match: Booking.com reference number appears in the recipient
        // field or in a manually added comment on the invoice.
        const refMatch =
            invoice.recipient.includes(payment.referenceNumber) ||
            !!(invoice.comment?.includes(payment.referenceNumber));

        // Date window: the invoice date must fall within
        //   [checkIn − BOOKING_DATE_TOLERANCE, payout + BOOKING_DATE_TOLERANCE].
        // Both dates are nullable after the schema migration; skip date check
        // when they are missing and rely on the reference match alone.
        let dateMatch = false;
        if (payment.checkInDate && payment.payoutDate) {
            // differenceInDays(a, b) = a − b in whole days
            // invoiceDay >= −tol  →  invoice is at most tol days before check-in
            // payoutDay  <=  tol  →  invoice is at most tol days after payout
            const invoiceDay = differenceInDays(invoice.invoiceDate, payment.checkInDate);
            const payoutDay  = differenceInDays(invoice.invoiceDate, payment.payoutDate);
            dateMatch = invoiceDay >= -BOOKING_DATE_TOLERANCE && payoutDay <= BOOKING_DATE_TOLERANCE;
        }

        let shouldMatch = false;
        if (pass === 1 && refMatch) shouldMatch = true;
        else if (pass === 2 && dateMatch) shouldMatch = true;

        if (shouldMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId:        invoice.id,
                bookingPaymentId: payment.id,
                matchType:        refMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                confidence:       refMatch ? 1.0 : 0.85,
            });
            return 'AUTOMATIC';
        }
    }
    return 'NONE';
}

function getCardGroup(name: string): number {
    const n = name.toLowerCase();
    if (n.includes('mastercard') || n.includes('eurocard')) return 1;
    if (n.includes('visa') || n.includes('v pay') || n.includes('v-pay') || n.includes('vpay')) return 2;
    if (n.includes('ec-karte') || n.includes('girocard') || n.includes('maestro') || n.includes('debit')) return 3;
    if (n.includes('american express') || n.includes('amex')) return 4;
    return 0; // Unknown group
}

function isCardTypeMismatch(invType: string, payType: string): boolean {
    const g1 = getCardGroup(invType);
    const g2 = getCardGroup(payType);
    if (g1 === 0 || g2 === 0) return false; // If we can't categorize one, assume no mismatch to be safe
    return g1 !== g2;
}

function matchCard(
    invoice: Invoice,
    invoiceCents: number,
    index: Map<number, CardWithMatches[]>,
    matchedIds: Set<number>,
    results: MatchRecord[],
    pass: number
): 'NONE' | 'AUTOMATIC' | 'SUGGESTED_MISMATCH' {
    const candidates = getCandidates(index, invoiceCents);

    for (const payment of candidates) {
        if (matchedIds.has(payment.id)) continue;
        const diffDays = Math.abs(differenceInDays(invoice.invoiceDate, payment.transactionDate));
        const mismatch = isCardTypeMismatch(invoice.paymentType, payment.cardType);

        let shouldMatch = false;
        
        if (pass === 1 && diffDays === 0 && !mismatch) shouldMatch = true;
        else if (pass === 2 && diffDays === 0 && mismatch) shouldMatch = true;
        else if (pass === 3 && diffDays <= DATE_TOLERANCE_DAYS && !mismatch) shouldMatch = true;
        else if (pass === 4 && diffDays <= DATE_TOLERANCE_DAYS && mismatch) shouldMatch = true;

        if (shouldMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId:     invoice.id,
                cardPaymentId: payment.id,
                matchType:     mismatch ? 'SUGGESTED_MISMATCH' : 'AUTOMATIC',
                confidence:    mismatch ? (pass === 2 ? 0.70 : 0.60) : (pass === 1 ? 0.95 : 0.85),
            });
            return mismatch ? 'SUGGESTED_MISMATCH' : 'AUTOMATIC';
        }
    }

    return 'NONE';
}

function matchBank(
    invoice: Invoice,
    invoiceCents: number,
    index: Map<number, BankWithMatches[]>,
    matchedIds: Set<number>,
    results: MatchRecord[],
    pass: number
): 'NONE' | 'AUTOMATIC' | 'SUGGESTED_MISMATCH' {
    for (const payment of getCandidates(index, invoiceCents)) {
        if (matchedIds.has(payment.id)) continue;

        const diffDays = Math.abs(differenceInDays(invoice.invoiceDate, payment.bookingDate));
        if (diffDays > BANK_DATE_TOLERANCE_DAYS) continue;

        const nameMatch =
            !!payment.senderReceiver && !!invoice.recipient &&
            (payment.senderReceiver.toLowerCase().includes(invoice.recipient.toLowerCase()) ||
             invoice.recipient.toLowerCase().includes(payment.senderReceiver.toLowerCase()));

        const invoiceNum = extractInvoiceNumber(invoice.invoiceNumber);
        const descMatch  =
            !!invoiceNum &&
            !!payment.description &&
            payment.description.includes(invoiceNum);

        let shouldMatch = false;
        
        // Pass 1: Strict match (description match)
        if (pass === 1 && descMatch) shouldMatch = true;
        // Pass 2: Name match
        else if (pass === 2 && nameMatch) shouldMatch = true;

        if (shouldMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId:         invoice.id,
                bankTransactionId: payment.id,
                matchType:         descMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                confidence:        descMatch ? 1.0 : 0.8,
            });
            return 'AUTOMATIC';
        }
    }
    return 'NONE';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCardPayment(type: string): boolean {
    const t = type.toLowerCase();
    return (
        t.includes('ec-karte')     ||
        t.includes('visa')         ||
        t.includes('mastercard')   ||
        t.includes('maestro')      ||
        t.includes('visa electron')
    );
}

/**
 * Extracts the most specific (longest) digit run from an invoice number.
 *
 * Previous implementation took the FIRST digit run, so "2025-001" → "2025".
 * The year "2025" appears in thousands of bank transfer descriptions and
 * caused false-positive matches for bank reconciliation.
 * Taking the LONGEST run gives "001" for "2025-001" and "17841" for
 * "Rechnung 17841 / 2025" — both are the actual invoice identifiers.
 */
function extractInvoiceNumber(fullNumber: string): string | null {
    if (!fullNumber) return null;
    const runs = fullNumber.match(/\d+/g);
    if (!runs) return null;
    return runs.reduce((best, run) => (run.length > best.length ? run : best));
}
