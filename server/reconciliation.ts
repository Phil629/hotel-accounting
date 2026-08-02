import { Invoice, BankTransaction, BookingPayment, CardPayment, PmsPayment, RoomReservation, Prisma } from '@prisma/client';
import prisma from './db';

const DATE_TOLERANCE_DAYS      = 5;
const BANK_DATE_TOLERANCE_DAYS = 60;
const BOOKING_DATE_TOLERANCE   = 5;
const AMOUNT_TOLERANCE_CENTS   = 1;

type BookingWithMatches = BookingPayment  & { matches: { id: number }[] };
type CardWithMatches    = CardPayment     & { matches: { id: number }[] };
type BankWithMatches    = BankTransaction & { matches: { id: number }[] };
type MatchRecord        = Prisma.ReconciliationMatchCreateManyInput;

// ─── Amount Index ─────────────────────────────────────────────────────────────

function toCents(amount: Prisma.Decimal | number): number {
    return Math.round(Number(amount) * 100);
}

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

function getCandidates<T>(index: Map<number, T[]>, invoiceCents: number): T[] {
    const lo = index.get(invoiceCents - AMOUNT_TOLERANCE_CENTS) ?? [];
    const mid = index.get(invoiceCents)                          ?? [];
    const hi = index.get(invoiceCents + AMOUNT_TOLERANCE_CENTS) ?? [];
    if (lo.length === 0 && hi.length === 0) return mid;
    return [...lo, ...mid, ...hi];
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function differenceInDays(d1: Date, d2: Date): number {
    const utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
    const utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
    return Math.round((utc1 - utc2) / 86_400_000);
}

function extractInvoiceNumber(fullNumber: string | null | undefined): string | null {
    if (!fullNumber) return null;
    const exactMatch = fullNumber.match(/Rechnung\s+(\d+)/i);
    if (exactMatch) return exactMatch[1];
    
    const currentYear = new Date().getFullYear().toString();
    const withoutYear = fullNumber.replace(new RegExp(`\\b${currentYear}\\b`, 'g'), '');
    const runs = withoutYear.match(/\d+/g) || fullNumber.match(/\d+/g);
    if (!runs) return null;
    return runs.reduce((best, run) => (run.length > best.length ? run : best));
}

function cleanName(name: string | null | undefined): string {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]/g, '');
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runReconciliation(onProgress?: (progress: number, message: string) => void) {
    const notify = (p: number, m: string) => {
        console.log(`[${p}%] ${m}`);
        if (onProgress) onProgress(p, m);
    };

    notify(5, 'Starte Abgleich: Lese Rechnungen und Zimmer... (Schritt 1/5)');
    const nineMonthsAgo = new Date();
    nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);

    // 1. Link RoomReservations to Invoices
    const unlinkedRooms = await prisma.roomReservation.findMany({ where: { invoiceId: null } });
    const allInvoices = await prisma.invoice.findMany();
    
    for (const room of unlinkedRooms) {
        const roomNameClean = cleanName(room.guestName);
        const match = allInvoices.find(inv => {
            const invNameClean = cleanName(inv.recipient);
            const nameMatch = invNameClean.includes(roomNameClean) || roomNameClean.includes(invNameClean);
            const dateMatch = Math.abs(differenceInDays(room.checkOut, inv.invoiceDate)) <= 3;
            return nameMatch && dateMatch;
        });
        
        if (match) {
            await prisma.roomReservation.update({
                where: { id: room.id },
                data: { invoiceId: match.id }
            });
        }
    }

    // 2. Link PmsPayments to Invoices
    notify(20, 'Verknüpfe Zahlungsberichte mit Rechnungen... (Schritt 2/5)');
    const unlinkedPms = await prisma.pmsPayment.findMany({ where: { invoiceId: null } });
    for (const pms of unlinkedPms) {
        let match = null;
        if (pms.invoiceNumber) {
            const pmsNum = extractInvoiceNumber(pms.invoiceNumber);
            match = allInvoices.find(inv => extractInvoiceNumber(inv.invoiceNumber) === pmsNum);
        }
        if (!match && pms.recipient) {
            const pmsNameClean = cleanName(pms.recipient);
            match = allInvoices.find(inv => {
                const invNameClean = cleanName(inv.recipient);
                const nameMatch = invNameClean.includes(pmsNameClean) || pmsNameClean.includes(invNameClean);
                const dateMatch = Math.abs(differenceInDays(pms.paymentDate, inv.invoiceDate)) <= 3;
                return nameMatch && dateMatch;
            });
        }
        
        if (match) {
            await prisma.pmsPayment.update({
                where: { id: pms.id },
                data: { invoiceId: match.id }
            });
        }
    }

    // 3. Update Invoice amounts and statuses
    notify(35, 'Aktualisiere Rechnungsstatus (Bezahlt/Offen)... (Schritt 3/5)');
    const invoicesWithPayments = await prisma.invoice.findMany({
        include: { pmsPayments: true }
    });
    
    for (const inv of invoicesWithPayments) {
        let paid = 0;
        for (const p of inv.pmsPayments) {
            paid += Number(p.amount);
        }
        let status = 'OPEN';
        if (paid >= Number(inv.amount) - 0.05) status = 'PAID';
        else if (paid > 0) status = 'PARTIAL';
        
        if (Number(inv.amountPaid) === paid && inv.status === status) {
            continue;
        }
        
        await prisma.invoice.update({
            where: { id: inv.id },
            data: { amountPaid: paid, status }
        });
    }

    // 4. Match PmsPayments against Bank/Card/Booking
    notify(50, 'Lade externe Bank- und Kreditkartendaten... (Schritt 4/5)');
    const [pmsPaymentsToMatch, bookingPayments, cardPayments, bankTransactions] = await Promise.all([
        prisma.pmsPayment.findMany({
            where: { matches: { none: {} }, invoiceId: { not: null } },
            include: { invoice: { include: { roomReservations: true } } }
        }),
        prisma.bookingPayment.findMany({
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

    const availableBookings = bookingPayments.filter(p => p.matches.length === 0);
    const availableCards    = cardPayments.filter(p => p.matches.length === 0);
    const availableBanks    = bankTransactions.filter(p => p.matches.length === 0);

    const bookingIndex = buildAmountIndex(availableBookings);
    const cardIndex    = buildAmountIndex(availableCards);
    const bankIndex    = buildAmountIndex(availableBanks);

    const matchedBookingIds = new Set<number>();
    const matchedCardIds    = new Set<number>();
    const matchedBankIds    = new Set<number>();
    const matchedPmsIds     = new Set<number>();

    const matchesToCreate: MatchRecord[] = [];

    for (let pass = 1; pass <= 4; pass++) {
        if (pass === 1) notify(60, 'Suche eindeutige Matches (100% Namensübereinstimmung)...');
        if (pass === 2) notify(70, 'Suche starke Matches (Ohne Betragsabweichung)...');
        if (pass === 3) notify(80, 'Suche ungefähre Matches (Erweiterter Namensabgleich)...');
        if (pass === 4) notify(90, 'Suche Mismatch-Vorschläge...');

        for (const pms of pmsPaymentsToMatch) {
            if (matchedPmsIds.has(pms.id)) continue;
            
            if (pms.paymentType.toLowerCase().includes('bar')) {
                if (pass === 1 && pms.invoiceId) {
                    matchesToCreate.push({
                        invoiceId: pms.invoiceId,
                        pmsPaymentId: pms.id,
                        matchType: 'AUTOMATIC',
                        confidence: 1.0
                    });
                    matchedPmsIds.add(pms.id);
                }
                continue;
            }

            const cents = toCents(pms.amount);
            const isAirbnb = pms.invoice?.roomReservations?.some(r => r.isAirbnb) ?? false;
            let matched = false;

            if (isAirbnb || pms.paymentType.toLowerCase().includes('banküberweisung') || pms.paymentType.toLowerCase().includes('überweisung')) {
                matched = matchBank(pms, cents, bankIndex, matchedBankIds, matchesToCreate, pass);
            } else if (pms.paymentType.toLowerCase().includes('booking.com')) {
                matched = matchBooking(pms, cents, bookingIndex, matchedBookingIds, matchesToCreate, pass);
            } else if (isCardPayment(pms.paymentType)) {
                matched = matchCard(pms, cents, cardIndex, matchedCardIds, matchesToCreate, pass);
            }

            if (matched) matchedPmsIds.add(pms.id);
        }
    }

    notify(95, `Speichere ${matchesToCreate.length} Matches in der Datenbank... (Schritt 5/5)`);

    // Group into batches of 500
    for (let i = 0; i < matchesToCreate.length; i += 500) {
        await prisma.reconciliationMatch.createMany({ data: matchesToCreate.slice(i, i + 500) });
    }

    const allInvoicesToCheck = await prisma.invoice.findMany({
        include: { pmsPayments: { include: { matches: true } } }
    });
    
    let fullyReconciled = 0;
    for (const inv of allInvoicesToCheck) {
        if (inv.isReconciled) continue;
        if (inv.status === 'PAID' && inv.pmsPayments.length > 0) {
            const allMatched = inv.pmsPayments.every(p => p.matches.length > 0 || p.paymentType.toLowerCase().includes('bar'));
            if (allMatched) {
                await prisma.invoice.update({
                    where: { id: inv.id },
                    data: { isReconciled: true, reconciledDate: new Date() }
                });
                fullyReconciled++;
            }
        }
    }

    console.log(`Reconciliation complete. ${fullyReconciled} invoices fully matched.`);
    return { matches: fullyReconciled };
}

// ─── Matchers ─────────────────────────────────────────────────────────────────

function matchBooking(
    pms: PmsPayment & { invoice?: (Invoice & { roomReservations: RoomReservation[] }) | null },
    cents: number,
    index: Map<number, BookingWithMatches[]>,
    matchedIds: Set<number>,
    results: MatchRecord[],
    pass: number
): boolean {
    for (const payment of getCandidates(index, cents)) {
        if (matchedIds.has(payment.id)) continue;

        const refMatch = pms.recipient?.includes(payment.referenceNumber) || pms.invoice?.comment?.includes(payment.referenceNumber);
        
        let dateMatch = false;
        if (payment.checkInDate && payment.payoutDate) {
            const pmsDay = differenceInDays(pms.paymentDate, payment.checkInDate);
            const payoutDay  = differenceInDays(pms.paymentDate, payment.payoutDate);
            dateMatch = pmsDay >= -BOOKING_DATE_TOLERANCE && payoutDay <= BOOKING_DATE_TOLERANCE;
        }

        let shouldMatch = false;
        if (pass === 1 && refMatch) shouldMatch = true;
        else if (pass === 2 && dateMatch) shouldMatch = true;

        if (shouldMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId:        pms.invoiceId as number,
                pmsPaymentId:     pms.id,
                bookingPaymentId: payment.id,
                matchType:        refMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                confidence:       refMatch ? 1.0 : 0.85,
            });
            return true;
        }
    }
    return false;
}

function getCardGroup(name: string): number {
    const n = name.toLowerCase();
    if (n.includes('mastercard') || n.includes('eurocard')) return 1;
    if (n.includes('visa') || n.includes('v pay') || n.includes('v-pay') || n.includes('vpay')) return 2;
    if (n.includes('ec-karte') || n.includes('girocard') || n.includes('maestro') || n.includes('debit')) return 3;
    if (n.includes('american express') || n.includes('amex')) return 4;
    return 0;
}

function isCardTypeMismatch(invType: string, payType: string): boolean {
    const g1 = getCardGroup(invType);
    const g2 = getCardGroup(payType);
    if (g1 === 0 || g2 === 0) return false; 
    return g1 !== g2;
}

function matchCard(
    pms: PmsPayment,
    cents: number,
    index: Map<number, CardWithMatches[]>,
    matchedIds: Set<number>,
    results: MatchRecord[],
    pass: number
): boolean {
    const candidates = getCandidates(index, cents);

    for (const payment of candidates) {
        if (matchedIds.has(payment.id)) continue;
        const diffDays = Math.abs(differenceInDays(pms.paymentDate, payment.transactionDate));
        const mismatch = isCardTypeMismatch(pms.paymentType, payment.cardType);

        let shouldMatch = false;
        if (pass === 1 && diffDays === 0 && !mismatch) shouldMatch = true;
        else if (pass === 2 && diffDays === 0 && mismatch) shouldMatch = true;
        else if (pass === 3 && diffDays <= DATE_TOLERANCE_DAYS && !mismatch) shouldMatch = true;
        else if (pass === 4 && diffDays <= DATE_TOLERANCE_DAYS && mismatch) shouldMatch = true;

        if (shouldMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId:     pms.invoiceId as number,
                pmsPaymentId:  pms.id,
                cardPaymentId: payment.id,
                matchType:     mismatch ? 'SUGGESTED_MISMATCH' : 'AUTOMATIC',
                confidence:    mismatch ? (pass === 2 ? 0.70 : 0.60) : (pass === 1 ? 0.95 : 0.85),
            });
            return true;
        }
    }
    return false;
}

function matchBank(
    pms: PmsPayment & { invoice?: (Invoice & { roomReservations: RoomReservation[] }) | null },
    cents: number,
    index: Map<number, BankWithMatches[]>,
    matchedIds: Set<number>,
    results: MatchRecord[],
    pass: number
): boolean {
    for (const payment of getCandidates(index, cents)) {
        if (matchedIds.has(payment.id)) continue;

        const diffDays = Math.abs(differenceInDays(pms.paymentDate, payment.bookingDate));
        if (diffDays > BANK_DATE_TOLERANCE_DAYS) continue;

        const pmsRecipient = pms.recipient ?? pms.invoice?.recipient ?? '';
        const nameMatch =
            !!payment.senderReceiver && !!pmsRecipient &&
            (payment.senderReceiver.toLowerCase().includes(pmsRecipient.toLowerCase()) ||
             pmsRecipient.toLowerCase().includes(payment.senderReceiver.toLowerCase()));

        const invoiceNum = extractInvoiceNumber(pms.invoiceNumber ?? pms.invoice?.invoiceNumber ?? null);
        const descMatch  =
            !!invoiceNum &&
            !!payment.description &&
            payment.description.includes(invoiceNum);

        let shouldMatch = false;
        if (pass === 1 && descMatch) shouldMatch = true;
        else if (pass === 2 && nameMatch) shouldMatch = true;

        if (shouldMatch) {
            matchedIds.add(payment.id);
            results.push({
                invoiceId:         pms.invoiceId as number,
                pmsPaymentId:      pms.id,
                bankTransactionId: payment.id,
                matchType:         descMatch ? 'MANUAL_REF' : 'AUTOMATIC',
                confidence:        descMatch ? 1.0 : 0.8,
            });
            return true;
        }
    }
    return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isCardPayment(type: string): boolean {
    const t = type.toLowerCase();
    return (
        t.includes('ec-karte')     ||
        t.includes('visa')         ||
        t.includes('mastercard')   ||
        t.includes('maestro')      ||
        t.includes('american express') ||
        t.includes('amex')         ||
        t.includes('v pay')        ||
        t.includes('v-pay')        ||
        t.includes('girocard')     ||
        t.includes('visa electron')
    );
}
