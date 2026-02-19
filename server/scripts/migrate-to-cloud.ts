
import Database from 'better-sqlite3';
import { Client } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

// Load .env from server root
dotenv.config({ path: path.join(__dirname, '../.env') });

// Adjust path to dev.db relative to this script
const dbPath = path.join(__dirname, '../prisma/dev.db');
const sqlite = new Database(dbPath);

const pgClient = new Client({
    connectionString: process.env.DATABASE_URL,
});

const toBool = (val: any) => val === 1;
const toDate = (val: any) => val ? new Date(val) : null;

async function migrate() {
    console.log(`Reading from SQLite at ${dbPath}...`);
    console.log(`Connecting to Postgres at ${process.env.DATABASE_URL?.split('@')[1]}...`); // Log only host for safety

    await pgClient.connect();

    try {
        // 1. Imported Files
        console.log('Migrating ImportedFiles...');
        const files = sqlite.prepare('SELECT * FROM ImportedFile').all();
        for (const f of files as any[]) {
            const res = await pgClient.query(
                `SELECT id FROM "ImportedFile" WHERE "originalName" = $1 AND "importDate" = $2`,
                [f.originalName, toDate(f.importDate)]
            );

            if (res.rowCount === 0) {
                await pgClient.query(
                    `INSERT INTO "ImportedFile" ("filename", "originalName", "type", "importDate", "recordCount", "dateRangeStart", "dateRangeEnd", "logs")
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [f.filename, f.originalName, f.type, toDate(f.importDate), f.recordCount, toDate(f.dateRangeStart), toDate(f.dateRangeEnd), f.logs]
                );
            }
        }

        // 2. Invoices
        console.log('Migrating Invoices...');
        const invoices = sqlite.prepare('SELECT * FROM Invoice').all();
        let invoiceMap = new Map<number, number>();

        for (const inv of invoices as any[]) {
            const res = await pgClient.query(
                `SELECT id FROM "Invoice" WHERE "invoiceNumber" = $1`,
                [inv.invoiceNumber]
            );

            let newId;
            if (res.rowCount === 0) {
                const insertRes = await pgClient.query(
                    `INSERT INTO "Invoice" ("invoiceDate", "paymentType", "invoiceNumber", "recipient", "amount", "isReconciled", "reconciledDate", "manualStatus", "comment", "dunningStatus", "dunningMethod", "dunningDate", "createdAt", "updatedAt")
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                     RETURNING id`,
                    [
                        toDate(inv.invoiceDate), inv.paymentType, inv.invoiceNumber, inv.recipient, inv.amount,
                        toBool(inv.isReconciled), toDate(inv.reconciledDate), toBool(inv.manualStatus), inv.comment,
                        inv.dunningStatus, inv.dunningMethod, toDate(inv.dunningDate),
                        toDate(inv.createdAt) || new Date(), toDate(inv.updatedAt) || new Date()
                    ]
                );
                newId = insertRes.rows[0].id;
            } else {
                newId = res.rows[0].id;
            }
            invoiceMap.set(inv.id, newId);
        }

        // 3. Payments
        console.log('Migrating Payments...');

        // Bank
        const bankTx = sqlite.prepare('SELECT * FROM BankTransaction').all();
        let bankMap = new Map<number, number>();
        for (const tx of bankTx as any[]) {
            const res = await pgClient.query(
                `SELECT id FROM "BankTransaction" WHERE "bookingDate" = $1 AND "amount" = $2 AND "description" = $3`,
                [toDate(tx.bookingDate), tx.amount, tx.description]
            );

            if (res.rowCount === 0) {
                const insertRes = await pgClient.query(
                    `INSERT INTO "BankTransaction" ("bookingDate", "amount", "currency", "senderReceiver", "description", "createdAt", "updatedAt")
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     RETURNING id`,
                    [
                        toDate(tx.bookingDate), tx.amount, tx.currency, tx.senderReceiver, tx.description,
                        toDate(tx.createdAt) || new Date(), toDate(tx.updatedAt) || new Date()
                    ]
                );
                bankMap.set(tx.id, insertRes.rows[0].id);
            } else {
                bankMap.set(tx.id, res.rows[0].id);
            }
        }

        // Booking
        const bookingTx = sqlite.prepare('SELECT * FROM BookingPayment').all();
        let bookingMap = new Map<number, number>();
        for (const tx of bookingTx as any[]) {
            const res = await pgClient.query(
                `SELECT id FROM "BookingPayment" WHERE "referenceNumber" = $1`,
                [tx.referenceNumber]
            );

            if (res.rowCount === 0) {
                const insertRes = await pgClient.query(
                    `INSERT INTO "BookingPayment" ("referenceNumber", "checkInDate", "checkOutDate", "payoutDate", "amount", "currency", "createdAt", "updatedAt")
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     RETURNING id`,
                    [
                        tx.referenceNumber,
                        toDate(tx.checkInDate) || new Date(), // Fallback if null
                        toDate(tx.checkOutDate) || toDate(tx.checkInDate) || new Date(), // Fallback to checkIn or now
                        toDate(tx.payoutDate) || new Date(),
                        tx.amount, tx.currency,
                        toDate(tx.createdAt) || new Date(), toDate(tx.updatedAt) || new Date()
                    ]
                );
                bookingMap.set(tx.id, insertRes.rows[0].id);
            } else {
                bookingMap.set(tx.id, res.rows[0].id);
            }
        }

        // Card
        const cardTx = sqlite.prepare('SELECT * FROM CardPayment').all();
        let cardMap = new Map<number, number>();
        for (const tx of cardTx as any[]) {
            const res = await pgClient.query(
                `SELECT id FROM "CardPayment" WHERE "transactionDate" = $1 AND "amount" = $2 AND "cardType" = $3`,
                [toDate(tx.transactionDate), tx.amount, tx.cardType]
            );

            if (res.rowCount === 0) {
                const insertRes = await pgClient.query(
                    `INSERT INTO "CardPayment" ("transactionDate", "cardType", "amount", "grossAmount", "createdAt", "updatedAt")
                      VALUES ($1, $2, $3, $4, $5, $6)
                      RETURNING id`,
                    [
                        toDate(tx.transactionDate), tx.cardType, tx.amount, tx.grossAmount,
                        toDate(tx.createdAt) || new Date(), toDate(tx.updatedAt) || new Date()
                    ]
                );
                cardMap.set(tx.id, insertRes.rows[0].id);
            } else {
                cardMap.set(tx.id, res.rows[0].id);
            }
        }

        // 4. Reconciliation Matches
        console.log('Migrating Matches...');
        const matches = sqlite.prepare('SELECT * FROM ReconciliationMatch').all();
        for (const match of matches as any[]) {
            const newInvoiceId = invoiceMap.get(match.invoiceId);
            if (!newInvoiceId) continue;

            let newBankId = match.bankTransactionId ? bankMap.get(match.bankTransactionId) : null;
            let newBookingId = match.bookingPaymentId ? bookingMap.get(match.bookingPaymentId) : null;
            let newCardId = match.cardPaymentId ? cardMap.get(match.cardPaymentId) : null;

            // Check deduplication
            const checkQuery = `
                SELECT id FROM "ReconciliationMatch" 
                WHERE "invoiceId" = $1 
                AND ("bankTransactionId" = $2 OR ($2 IS NULL AND "bankTransactionId" IS NULL))
                AND ("bookingPaymentId" = $3 OR ($3 IS NULL AND "bookingPaymentId" IS NULL))
                AND ("cardPaymentId" = $4 OR ($4 IS NULL AND "cardPaymentId" IS NULL))
            `;

            const res = await pgClient.query(checkQuery, [newInvoiceId, newBankId, newBookingId, newCardId]);

            if (res.rowCount === 0) {
                await pgClient.query(
                    `INSERT INTO "ReconciliationMatch" ("invoiceId", "bankTransactionId", "bookingPaymentId", "cardPaymentId", "matchType", "confidence", "createdAt")
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        newInvoiceId, newBankId, newBookingId, newCardId,
                        match.matchType, match.confidence, toDate(match.createdAt) || new Date()
                    ]
                );
            }
        }

        console.log('Migration complete!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pgClient.end();
        sqlite.close();
    }
}

migrate();
