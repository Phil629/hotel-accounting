import fs from 'fs';
import { parse } from 'csv-parse';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const prisma = new PrismaClient();

interface ParsedData {
    type: 'BOOKING' | 'IBELSA' | 'BANK' | 'NEXI' | 'UNKNOWN';
    count: number;
    dateRangeStart?: Date;
    dateRangeEnd?: Date;
    logs?: string[];
}

// Helper: Detect Delimiter
function detectDelimiter(content: string): string {
    const firstLine = content.split(/\r?\n/)[0];
    if (firstLine.includes(';')) return ';';
    if (firstLine.includes('\t')) return '\t';
    return ',';
}

export async function processFile(filePath: string): Promise<ParsedData> {
    const fileContent = fs.readFileSync(filePath, 'utf-8');

    // Detect Type based on Header
    const lines = fileContent.split(/\r?\n/);
    const header = lines[0];

    console.log(`Processing file: ${path.basename(filePath)}`);
    console.log(`Header detected: ${header}`);

    if ((header.includes('Referenznummer') && header.includes('Datum')) || header.includes('Booking.com') || (header.includes('Reference number') && header.includes('Payout date'))) {
        return await parseBooking(fileContent);
    } else if ((header.includes('Rechnungsdatum') && header.includes('Rechnungsnummer')) || header.includes('ibelsa')) {
        return await parseIbelsa(fileContent);
    } else if ((header.includes('Buchungstag') && header.includes('Verwendungszweck')) || header.includes('Valutadatum')) {
        return await parseBank(fileContent);
    } else if ((header.includes('Transaktionsdatum') || header.includes('Belegdatum')) && (header.includes('Umsatz') || header.includes('Betrag'))) {
        return await parseNexi(fileContent);
    }

    console.log("Unknown file header. Trying generic detection...");
    // Fallback: Try to parse as Nexi if it looks like a CSV with transaction data
    if (header.includes('Date') && header.includes('Amount')) {
        return await parseNexi(fileContent);
    }

    return { type: 'UNKNOWN', count: 0 };
}

// Helper: Parse German Date (dd.MM.yyyy, dd.MM.yy, yyyy-mm-dd, etc.)
function parseDate(dateStr: string): Date | null {
    if (!dateStr) return null;
    let clean = dateStr.trim();

    // Try standard dd.MM.yyyy or dd.MM.yy
    if (clean.includes('.')) {
        const parts = clean.split('.');
        if (parts.length === 3) {
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            let year = parseInt(parts[2]);
            // Handle 2-digit year
            if (year < 100) year += 2000;
            if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
                return new Date(year, month, day);
            }
        }
    }

    // Try yyyy-mm-dd
    if (clean.includes('-')) {
        const parts = clean.split('-');
        if (parts.length === 3) {
            // Check if first part is year (4 digits)
            if (parts[0].length === 4) {
                return new Date(clean);
            }
            // Maybe dd-mm-yyyy?
            const day = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1;
            const year = parseInt(parts[2]);
            return new Date(year, month, day);
        }
    }

    // Try verbose format (14. Okt. 2025, 9 Jun 2025)
    const months: { [key: string]: number } = {
        // German Short
        'Jan': 0, 'Feb': 1, 'Mär': 2, 'Apr': 3, 'Mai': 4, 'Jun': 5,
        'Jul': 6, 'Aug': 7, 'Sep': 8, 'Sept': 8, 'Okt': 9, 'Nov': 10, 'Dez': 11,
        // German Full
        'Januar': 0, 'Februar': 1, 'März': 2, 'April': 3, 'Juni': 5,
        'Juli': 6, 'August': 7, 'September': 8, 'Oktober': 9, 'November': 10, 'Dezember': 11,
        // English Short & Full
        'Oct': 9, 'Dec': 11, 'Mar': 2, 'May': 4,
        'January': 0, 'February': 1, 'March': 2, 'June': 5, 'July': 6, 'October': 9, 'December': 11
    };

    // Clean up the string: remove quotes, extra spaces
    clean = clean.replace(/['"]/g, '').trim();

    // Try splitting by space
    const verboseParts = clean.split(' ');
    if (verboseParts.length >= 3) {
        // Handle "9 Jun 2025" or "14. Okt. 2025"
        const dayStr = verboseParts[0].replace('.', '');
        const monthStr = verboseParts[1].replace('.', '');
        const yearStr = verboseParts[2];

        const day = parseInt(dayStr);
        const year = parseInt(yearStr);
        const month = months[monthStr];

        if (!isNaN(day) && month !== undefined && !isNaN(year)) {
            return new Date(year, month, day);
        }
    }

    return null;
}

// Helper: Parse Amount (1.500,00 -> 1500.00)
function parseAmount(amountStr: string): number {
    if (!amountStr) return 0;
    // Remove all non-numeric chars except , . -
    let clean = amountStr.replace(/[^0-9,.-]/g, '').trim();

    // Detect format:
    // German: 1.234,56 (comma is decimal)
    // English: 1,234.56 (dot is decimal)

    // Simple heuristic: last separator is likely decimal
    const lastComma = clean.lastIndexOf(',');
    const lastDot = clean.lastIndexOf('.');

    if (lastComma > lastDot) {
        // German format: remove dots, replace comma with dot
        clean = clean.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
        // English format: remove commas
        clean = clean.replace(/,/g, '');
    }

    return parseFloat(clean);
}

async function parseBooking(content: string): Promise<ParsedData> {
    const delimiter = detectDelimiter(content);
    console.log(`Parsing Booking.com with delimiter: '${delimiter}'`);

    return new Promise((resolve, reject) => {
        // Parse WITH headers to get the header row
        parse(content, { delimiter, from_line: 1, relax_quotes: true }, async (err, records) => {
            if (err) return reject(err);

            if (records.length < 2) {
                return resolve({ type: 'BOOKING', count: 0, logs: ["File too short, no data rows"] });
            }

            // 1. Map Columns from Header (Row 0)
            const header = records[0].map((col: string) => col.toLowerCase().trim());
            console.log("Booking.com Header:", header);

            const colMap = {
                ref: header.findIndex((h: string) => h.includes('referenz') || h.includes('reference') || h.includes('booking number')),
                checkIn: header.findIndex((h: string) => h.includes('check-in') || h.includes('anreise')),
                checkOut: header.findIndex((h: string) => h.includes('check-out') || h.includes('abreise')),
                amount: header.findIndex((h: string) => h.includes('betrag') || h.includes('amount') || h.includes('total')),
                payout: header.findIndex((h: string) => h.includes('auszahlungsdatum') || h.includes('payout date') || h.includes('datum der auszahlung'))
            };

            console.log("Column Mapping:", colMap);
            const logs: string[] = [`Column Mapping: ${JSON.stringify(colMap)}`];

            if (colMap.ref === -1 || colMap.amount === -1) {
                logs.push("Critical columns missing (Reference or Amount)");
                return resolve({ type: 'BOOKING', count: 0, logs });
            }

            let count = 0;
            let minDate: Date | null = null;
            let maxDate: Date | null = null;

            // 2. Collect all data in memory first
            const upsertOps: any[] = [];
            for (let i = 1; i < records.length; i++) {
                const row = records[i];
                try {
                    const ref = row[colMap.ref];
                    const checkIn = colMap.checkIn > -1 ? parseDate(row[colMap.checkIn]) : null;
                    const checkOut = colMap.checkOut > -1 ? parseDate(row[colMap.checkOut]) : null;
                    const amount = parseAmount(row[colMap.amount]);
                    const payoutDate = colMap.payout > -1 ? parseDate(row[colMap.payout]) : null;

                    if (!ref || !amount) continue;

                    upsertOps.push(
                        prisma.bookingPayment.upsert({
                            where: { referenceNumber: ref },
                            update: {
                                checkInDate: checkIn || undefined,
                                checkOutDate: checkOut || undefined,
                                payoutDate: payoutDate || undefined,
                                amount: amount
                            },
                            create: {
                                referenceNumber: ref,
                                checkInDate: checkIn || new Date(0),
                                checkOutDate: checkOut || new Date(0),
                                payoutDate: payoutDate || new Date(0),
                                amount: amount
                            }
                        })
                    );
                    count++;

                    if (checkIn) {
                        if (!minDate || checkIn < minDate) minDate = checkIn;
                    }
                    if (payoutDate) {
                        if (!maxDate || payoutDate > maxDate) maxDate = payoutDate;
                    }
                } catch (e) {
                    console.error("Error parsing booking row", row, e);
                    logs.push(`Error parsing row ${i}: ${e}`);
                }
            }

            // 3. Execute all upserts in a single transaction
            if (upsertOps.length > 0) {
                await prisma.$transaction(upsertOps);
            }
            resolve({ type: 'BOOKING', count, dateRangeStart: minDate || undefined, dateRangeEnd: maxDate || undefined, logs });
        });
    });
}

async function parseIbelsa(content: string): Promise<ParsedData> {
    const delimiter = detectDelimiter(content);
    return new Promise((resolve, reject) => {
        parse(content, { delimiter, from_line: 2, relax_quotes: true }, async (err, records) => {
            if (err) return reject(err);

            let count = 0;
            let minDate: Date | null = null;
            let maxDate: Date | null = null;
            const upsertOps: any[] = [];

            for (const row of records) {
                try {
                    const date = parseDate(row[0]);
                    const type = row[1];
                    const number = row[2];
                    const recipient = row[3];
                    const amount = parseAmount(row[5]);

                    if (date && number) {
                        upsertOps.push(
                            prisma.invoice.upsert({
                                where: { invoiceNumber: number },
                                update: {},
                                create: {
                                    invoiceDate: date,
                                    paymentType: type,
                                    invoiceNumber: number,
                                    recipient: recipient,
                                    amount: amount
                                }
                            })
                        );
                        count++;
                        if (!minDate || date < minDate) minDate = date;
                        if (!maxDate || date > maxDate) maxDate = date;
                    }
                } catch (e) {
                    console.error("Error parsing Ibelsa row", row, e);
                }
            }

            if (upsertOps.length > 0) {
                await prisma.$transaction(upsertOps);
            }
            resolve({ type: 'IBELSA', count, dateRangeStart: minDate || undefined, dateRangeEnd: maxDate || undefined });
        });
    });
}

async function parseBank(content: string): Promise<ParsedData> {
    const delimiter = detectDelimiter(content);
    return new Promise((resolve, reject) => {
        parse(content, { delimiter, from_line: 2, relax_quotes: true }, async (err, records) => {
            if (err) return reject(err);

            let count = 0;
            let minDate: Date | null = null;
            let maxDate: Date | null = null;
            const createData: any[] = [];

            for (const row of records) {
                try {
                    const date = parseDate(row[4]);
                    const name = row[6];
                    const desc = row[10];
                    const amount = parseAmount(row[11]);

                    if (date) {
                        createData.push({
                            bookingDate: date,
                            senderReceiver: name,
                            description: desc,
                            amount: amount
                        });
                        count++;
                        if (!minDate || date < minDate) minDate = date;
                        if (!maxDate || date > maxDate) maxDate = date;
                    }
                } catch (e) {
                    console.error("Error parsing Bank row", row, e);
                }
            }

            if (createData.length > 0) {
                await prisma.bankTransaction.createMany({ data: createData });
            }
            resolve({ type: 'BANK', count, dateRangeStart: minDate || undefined, dateRangeEnd: maxDate || undefined });
        });
    });
}

async function parseNexi(content: string): Promise<ParsedData> {
    const delimiter = detectDelimiter(content);
    console.log(`Parsing Nexi with delimiter: '${delimiter}'`);

    return new Promise((resolve, reject) => {
        parse(content, { delimiter, from_line: 2, relax_quotes: true }, async (err, records) => {
            if (err) return reject(err);

            console.log(`Nexi records found: ${records.length}`);
            if (records.length > 0) {
                console.log("First Nexi row:", records[0]);
            }

            let count = 0;
            let minDate: Date | null = null;
            let maxDate: Date | null = null;
            const createData: any[] = [];

            for (const row of records) {
                try {
                    if (row.length < 3) {
                        console.warn("Skipping Nexi row, too few columns:", row);
                        continue;
                    }

                    const type = row[1];
                    const date = parseDate(row[2]);

                    let amount = parseAmount(row[10]);
                    let gross = parseAmount(row[11]);

                    if (amount === 0 && gross > 0) {
                        amount = gross;
                    }

                    if (date) {
                        createData.push({
                            transactionDate: date,
                            cardType: type,
                            amount: amount,
                            grossAmount: gross
                        });
                        count++;
                        if (!minDate || date < minDate) minDate = date;
                        if (!maxDate || date > maxDate) maxDate = date;
                    } else {
                        console.warn("Nexi row skipped, invalid date:", row[2]);
                    }
                } catch (e) {
                    console.error("Error parsing Nexi row", row, e);
                }
            }

            if (createData.length > 0) {
                await prisma.cardPayment.createMany({ data: createData });
            }
            resolve({ type: 'NEXI', count, dateRangeStart: minDate || undefined, dateRangeEnd: maxDate || undefined });
        });
    });
}
