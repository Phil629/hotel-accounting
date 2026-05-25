import fs from 'fs';
import { parse } from 'csv-parse';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import path from 'path';
import iconv from 'iconv-lite';
import prisma from './db';

const BATCH_SIZE = 500;

interface ParsedData {
    type: 'BOOKING' | 'IBELSA' | 'BANK' | 'NEXI' | 'UNKNOWN';
    count: number;
    dateRangeStart?: Date;
    dateRangeEnd?: Date;
    logs?: string[];
}

// ─── File Metadata ───────────────────────────────────────────────────────────

/**
 * Reads the first 4 KB of a file to determine encoding (BOM or UTF-8 validity
 * check, falls back to windows-1252 for German bank exports) plus the CSV
 * delimiter and first header line — all in a single file-open.
 */
async function readFileMetadata(filePath: string): Promise<{
    encoding: string;
    delimiter: string;
    header: string;
}> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buf, 0, 4096, 0);
        const raw = buf.slice(0, bytesRead);

        const encoding = detectEncoding(raw); // #6
        const firstLine = iconv.decode(raw, encoding).split(/\r?\n/)[0];
        const delimiter = firstLine.includes(';') ? ';'
                        : firstLine.includes('\t') ? '\t'
                        : ',';
        return { encoding, delimiter, header: firstLine };
    } finally {
        await handle.close();
    }
}

/**
 * BOM detection + strict UTF-8 validation.
 * Falls back to windows-1252, which is a superset of ISO-8859-1 and
 * correctly renders German umlauts from Sparkasse/Volksbank exports.
 */
function detectEncoding(buf: Buffer): string {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return 'utf-8';
    } catch {
        return 'windows-1252';
    }
}

/**
 * Returns an async-iterable stream of parsed CSV rows (#5).
 * fs.createReadStream → iconv decode → csv-parse.
 * The `for await...of` consumer drives backpressure naturally:
 * awaiting a DB flush inside the loop pauses the read automatically.
 */
function buildCsvStream(filePath: string, encoding: string, delimiter: string): AsyncIterable<string[]> {
    const parser = parse({ delimiter, from_line: 1, relax_quotes: true });
    fs.createReadStream(filePath)
        .pipe(iconv.decodeStream(encoding))
        .pipe(parser);
    return parser as unknown as AsyncIterable<string[]>;
}

// ─── Date & Amount Helpers ────────────────────────────────────────────────────

function parseDate(dateStr: string): Date | null {
    if (!dateStr) return null;
    let clean = dateStr.trim();

    // dd.MM.yyyy or dd.MM.yy
    if (clean.includes('.')) {
        const parts = clean.split('.');
        if (parts.length === 3) {
            const day   = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10) - 1;
            let   year  = parseInt(parts[2], 10);
            if (year < 100) year += 2000;
            if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                return new Date(year, month, day);
            }
        }
    }

    // yyyy-MM-dd or dd-MM-yyyy
    if (clean.includes('-')) {
        const parts = clean.split('-');
        if (parts.length === 3) {
            if (parts[0].length === 4) {
                // Use local Date constructor — avoids UTC midnight → local day-1 shift (#1)
                const [y, m, d] = parts.map(Number);
                if (!isNaN(y) && !isNaN(m) && !isNaN(d)) return new Date(y, m - 1, d);
            } else {
                const day   = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                const year  = parseInt(parts[2], 10);
                if (!isNaN(day) && !isNaN(month) && !isNaN(year)) return new Date(year, month, day);
            }
        }
    }

    // Verbose: "14. Okt. 2025", "9 Jun 2025"
    const months: Record<string, number> = {
        'Jan': 0, 'Feb': 1, 'Mär': 2, 'Apr': 3, 'Mai': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Sept': 8, 'Okt': 9, 'Nov': 10, 'Dez': 11,
        'Januar': 0, 'Februar': 1, 'März': 2, 'April': 3, 'Juni': 5,
        'Juli': 6, 'August': 7, 'September': 8, 'Oktober': 9, 'November': 10, 'Dezember': 11,
        'Oct': 9, 'Dec': 11, 'Mar': 2, 'May': 4,
        'January': 0, 'February': 1, 'March': 2, 'June': 5,
        'July': 6, 'October': 9, 'December': 11,
    };
    clean = clean.replace(/['"]/g, '').trim();
    const vp = clean.split(/\s+/);
    if (vp.length >= 3) {
        const day   = parseInt(vp[0].replace('.', ''), 10);
        const month = months[vp[1].replace('.', '')];
        const year  = parseInt(vp[2], 10);
        if (!isNaN(day) && month !== undefined && !isNaN(year)) return new Date(year, month, day);
    }

    return null;
}

function parseAmount(amountStr: string): number {
    if (!amountStr) return 0;
    let clean = amountStr.replace(/[^\d,.-]/g, '').trim();
    if (!clean) return 0;

    const lastComma = clean.lastIndexOf(',');
    const lastDot   = clean.lastIndexOf('.');

    if (lastComma > lastDot) {
        // German: 1.234,56 — remove thousand dots, comma becomes decimal point
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
        const decimalsAfterDot = clean.length - lastDot - 1;
        if (decimalsAfterDot === 3 && lastComma === -1) {
            // "1.000" — German thousand separator only, no decimal part (#13)
            clean = clean.replace(/\./g, '');
        } else {
            // English: 1,234.56 — remove thousand commas
            clean = clean.replace(/,/g, '');
        }
    }

    const result = parseFloat(clean);
    return isNaN(result) ? 0 : result;
}

function buildHash(...parts: (string | number | null | undefined)[]): string {
    return crypto
        .createHash('sha256')
        .update(parts.map(p => String(p ?? '')).join('|'))
        .digest('hex');
}

function updateDateRange(
    date: Date,
    min: Date | null,
    max: Date | null,
): [Date, Date] {
    return [
        !min || date < min ? date : min,
        !max || date > max ? date : max,
    ];
}

// Splits large upsert arrays into BATCH_SIZE chunks to prevent transaction timeouts (#10)
async function executeBatched(ops: Prisma.PrismaPromise<unknown>[]): Promise<void> {
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        await prisma.$transaction(ops.slice(i, i + BATCH_SIZE));
    }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

export async function processFile(filePath: string): Promise<ParsedData> {
    const { encoding, delimiter, header } = await readFileMetadata(filePath);

    console.log(`Processing: ${path.basename(filePath)} [encoding: ${encoding}, delimiter: '${delimiter}']`);
    console.log(`Header: ${header}`);

    const headerLower = header.toLowerCase();

    if (
        (headerLower.includes('referenznummer') && headerLower.includes('datum')) ||
        (headerLower.includes('buchungsnummer') && headerLower.includes('datum')) ||
        headerLower.includes('booking.com') ||
        (headerLower.includes('reference number') && headerLower.includes('payout date')) ||
        (headerLower.includes('booking number') && headerLower.includes('payout date')) ||
        (headerLower.includes('reference number') && headerLower.includes('amount')) ||
        (headerLower.includes('booking number') && headerLower.includes('amount'))
    ) {
        return parseBooking(filePath, encoding, delimiter);
    }

    if (
        (headerLower.includes('rechnungsdatum') && headerLower.includes('rechnungsnummer')) ||
        headerLower.includes('ibelsa')
    ) {
        return parseIbelsa(filePath, encoding, delimiter);
    }

    if (
        (headerLower.includes('buchungstag') && headerLower.includes('verwendungszweck')) ||
        headerLower.includes('valutadatum')
    ) {
        return parseBank(filePath, encoding, delimiter);
    }

    if (
        (headerLower.includes('transaktionsdatum') || headerLower.includes('belegdatum')) &&
        (headerLower.includes('umsatz') || headerLower.includes('betrag'))
    ) {
        return parseNexi(filePath, encoding, delimiter);
    }

    if (headerLower.includes('date') && headerLower.includes('amount')) {
        return parseNexi(filePath, encoding, delimiter);
    }

    console.log('Unknown file header — no parser matched.');
    return { type: 'UNKNOWN', count: 0, logs: [`Header: ${header}`] };
}

// ─── Booking.com ─────────────────────────────────────────────────────────────

async function parseBooking(filePath: string, encoding: string, delimiter: string): Promise<ParsedData> {
    const logs: string[] = [];
    const stream = buildCsvStream(filePath, encoding, delimiter);

    let headerMapped = false;
    let colMap = { ref: -1, checkIn: -1, checkOut: -1, amount: -1, payout: -1 };
    let count = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    let batch: Prisma.BookingPaymentCreateManyInput[] = [];

    async function flushBatch() {
        if (batch.length === 0) return;
        await prisma.bookingPayment.createMany({ data: batch, skipDuplicates: true });
        batch = [];
    }

    for await (const row of stream) {
        // First row is the header
        if (!headerMapped) {
            const h = row.map(c => c.toLowerCase().trim());
            colMap = {
                ref:      h.findIndex(c => c.includes('referenz') || c.includes('reference') || c.includes('booking number') || c.includes('buchungsnummer')),
                checkIn:  h.findIndex(c => c.includes('check-in')  || c.includes('anreise')),
                checkOut: h.findIndex(c => c.includes('check-out') || c.includes('abreise')),
                amount:   h.findIndex(c => c.includes('betrag')    || c.includes('amount') || c.includes('total')),
                payout:   h.findIndex(c => c.includes('auszahlungsdatum') || c.includes('payout date') || c.includes('datum der auszahlung')),
            };
            logs.push(`Column mapping: ${JSON.stringify(colMap)}`);
            if (colMap.ref === -1 || colMap.amount === -1) {
                logs.push('Critical columns missing (ref or amount) — aborting.');
                return { type: 'BOOKING', count: 0, logs };
            }
            headerMapped = true;
            continue;
        }

        try {
            const ref      = row[colMap.ref]?.trim();
            const checkIn  = colMap.checkIn  > -1 ? parseDate(row[colMap.checkIn])  : null;
            const checkOut = colMap.checkOut > -1 ? parseDate(row[colMap.checkOut]) : null;
            const payout   = colMap.payout   > -1 ? parseDate(row[colMap.payout])   : null;
            const amount   = parseAmount(row[colMap.amount]);

            if (!ref || !amount) continue;

            batch.push({
                referenceNumber: ref,
                checkInDate:  checkIn,
                checkOutDate: checkOut,
                payoutDate:   payout,
                amount,
            });
            count++;
            if (checkIn) [minDate, maxDate] = updateDateRange(checkIn, minDate, maxDate);
            if (payout)  [minDate, maxDate] = updateDateRange(payout,  minDate, maxDate);

            if (batch.length >= BATCH_SIZE) await flushBatch();
        } catch (e) {
            console.error('Booking.com row error', row, e);
            logs.push(`Row error: ${e}`);
        }
    }

    await flushBatch();
    return { type: 'BOOKING', count, dateRangeStart: minDate ?? undefined, dateRangeEnd: maxDate ?? undefined, logs };
}

// ─── Ibelsa ──────────────────────────────────────────────────────────────────

async function parseIbelsa(filePath: string, encoding: string, delimiter: string): Promise<ParsedData> {
    const stream = buildCsvStream(filePath, encoding, delimiter);

    let headerMapped = false;
    let colMap = { date: -1, type: -1, number: -1, recipient: -1, amount: -1 };
    let count = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    let batch: Prisma.InvoiceCreateManyInput[] = [];

    async function flushBatch() {
        if (batch.length === 0) return;
        await prisma.invoice.createMany({ data: batch, skipDuplicates: true });
        batch = [];
    }

    for await (const row of stream) {
        // Dynamic column mapping from header (#14) — replaces hardcoded row[0..5]
        if (!headerMapped) {
            const h = row.map(c => c.toLowerCase().trim());
            colMap = {
                date:      h.findIndex(c => c.includes('rechnungsdatum') || c.includes('datum')),
                type:      h.findIndex(c => c.includes('zahlungsart') || c.includes('typ') || c.includes('art')),
                number:    h.findIndex(c => c.includes('rechnungsnummer') || c.includes('nummer') || c.includes('nr')),
                recipient: h.findIndex(c => c.includes('empfänger') || c.includes('empfaenger') || c.includes('name') || c.includes('gast') || c.includes('kunde')),
                amount:    h.findIndex(c => c.includes('betrag') || c.includes('summe') || c.includes('amount') || c.includes('gesamt')),
            };
            if (colMap.date === -1 || colMap.number === -1 || colMap.amount === -1) {
                console.warn('Ibelsa: critical columns not found in header', h);
            }
            headerMapped = true;
            continue;
        }

        try {
            const date      = colMap.date      > -1 ? parseDate(row[colMap.date])        : null;
            const type      = colMap.type      > -1 ? row[colMap.type]?.trim()            : '';
            const number    = colMap.number    > -1 ? row[colMap.number]?.trim()          : '';
            const recipient = colMap.recipient > -1 ? row[colMap.recipient]?.trim() ?? '' : '';
            const amount    = colMap.amount    > -1 ? parseAmount(row[colMap.amount])     : 0;

            if (!date || !number) continue;

            const isCash = type.toLowerCase() === 'bar';
            batch.push({
                invoiceDate:    date,
                paymentType:    type,
                invoiceNumber:  number,
                recipient,
                amount,
                isReconciled:   isCash,
                manualStatus:   isCash,
                reconciledDate: isCash ? new Date() : null,
            });
            count++;
            [minDate, maxDate] = updateDateRange(date, minDate, maxDate);

            if (batch.length >= BATCH_SIZE) await flushBatch();
        } catch (e) {
            console.error('Ibelsa row error', row, e);
        }
    }

    await flushBatch();
    return { type: 'IBELSA', count, dateRangeStart: minDate ?? undefined, dateRangeEnd: maxDate ?? undefined };
}

// ─── Bank ─────────────────────────────────────────────────────────────────────

async function parseBank(filePath: string, encoding: string, delimiter: string): Promise<ParsedData> {
    const stream = buildCsvStream(filePath, encoding, delimiter);

    let headerMapped = false;
    let colMap = { date: -1, name: -1, description: -1, amount: -1 };
    let count = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    let batch: Prisma.BankTransactionCreateManyInput[] = [];

    async function flushBatch() {
        if (batch.length === 0) return;
        await prisma.bankTransaction.createMany({ data: batch, skipDuplicates: true }); // #2
        batch = [];
    }

    for await (const row of stream) {
        // Dynamic column mapping from header (#14) — replaces hardcoded row[4/6/10/11]
        if (!headerMapped) {
            const h = row.map(c => c.toLowerCase().trim());
            colMap = {
                date:        h.findIndex(c => c.includes('valutadatum') || c.includes('buchungstag') || c.includes('datum')),
                name:        h.findIndex(c => c.includes('auftraggeber') || c.includes('beguenstigter') || c.includes('empfaenger') || c.includes('name')),
                description: h.findIndex(c => c.includes('verwendungszweck') || c.includes('beschreibung') || c.includes('betreff')),
                amount:      h.findIndex(c => c.includes('betrag') || c.includes('amount')),
            };
            headerMapped = true;
            continue;
        }

        try {
            const date        = colMap.date        > -1 ? parseDate(row[colMap.date])         : null;
            const name        = colMap.name        > -1 ? row[colMap.name]?.trim()             : undefined;
            const description = colMap.description > -1 ? row[colMap.description]?.trim()      : undefined;
            const amount      = colMap.amount      > -1 ? parseAmount(row[colMap.amount])      : 0;

            if (!date) continue;

            // SHA-256 deduplication key: same row in a re-upload produces the same hash (#2)
            const externalHash = buildHash(date.toISOString(), amount, description ?? '');

            batch.push({ externalHash, bookingDate: date, senderReceiver: name, description, amount });
            count++;
            [minDate, maxDate] = updateDateRange(date, minDate, maxDate);

            if (batch.length >= BATCH_SIZE) await flushBatch(); // #10
        } catch (e) {
            console.error('Bank row error', row, e);
        }
    }

    await flushBatch();
    return { type: 'BANK', count, dateRangeStart: minDate ?? undefined, dateRangeEnd: maxDate ?? undefined };
}

// ─── Nexi / Card ─────────────────────────────────────────────────────────────

async function parseNexi(filePath: string, encoding: string, delimiter: string): Promise<ParsedData> {
    const stream = buildCsvStream(filePath, encoding, delimiter);

    let headerMapped = false;
    let colMap = { type: -1, date: -1, amount: -1, grossAmount: -1 };
    let count = 0;
    let minDate: Date | null = null;
    let maxDate: Date | null = null;
    let batch: Prisma.CardPaymentCreateManyInput[] = [];

    async function flushBatch() {
        if (batch.length === 0) return;
        await prisma.cardPayment.createMany({ data: batch, skipDuplicates: true }); // #2
        batch = [];
    }

    for await (const row of stream) {
        if (!headerMapped) {
            const h = row.map(c => c.toLowerCase().trim());
            colMap = {
                type:        h.findIndex(c => c.includes('karte') || c.includes('card') || c.includes('typ')),
                date:        h.findIndex(c => c.includes('transaktionsdatum') || c.includes('belegdatum') || c.includes('datum') || c.includes('date')),
                amount:      h.findIndex(c => c.includes('umsatz') || c.includes('betrag') || c.includes('amount')),
                grossAmount: h.findIndex(c => c.includes('brutto') || c.includes('gross')),
            };
            if (colMap.date === -1 || colMap.amount === -1) {
                console.warn('Nexi: critical columns not found in header', h);
            }
            headerMapped = true;
            continue;
        }

        if (row.length < 3) continue;

        try {
            const cardType  = colMap.type        > -1 ? row[colMap.type]?.trim() ?? ''     : '';
            const date      = colMap.date        > -1 ? parseDate(row[colMap.date])         : null;
            let   amount    = colMap.amount      > -1 ? parseAmount(row[colMap.amount])     : 0;
            const gross     = colMap.grossAmount > -1 ? parseAmount(row[colMap.grossAmount]): 0;

            if (amount === 0 && gross > 0) amount = gross;
            if (!date) { console.warn('Nexi: invalid date, row skipped', row); continue; }

            // SHA-256 deduplication key using the entire row to prevent dropping same-day identical amounts
            const externalHash = buildHash(row.join('|'));

            batch.push({ externalHash, transactionDate: date, cardType, amount, grossAmount: gross || null });
            count++;
            [minDate, maxDate] = updateDateRange(date, minDate, maxDate);

            if (batch.length >= BATCH_SIZE) await flushBatch(); // #10
        } catch (e) {
            console.error('Nexi row error', row, e);
        }
    }

    await flushBatch();
    return { type: 'NEXI', count, dateRangeStart: minDate ?? undefined, dateRangeEnd: maxDate ?? undefined };
}
