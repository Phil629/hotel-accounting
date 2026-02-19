
import { Client } from 'pg';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env') });

const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

async function createTables() {
    console.log('Connecting to Postgres...');
    await client.connect();

    try {
        console.log('Creating tables...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS "ImportedFile" (
                "id" SERIAL PRIMARY KEY,
                "filename" TEXT NOT NULL,
                "originalName" TEXT NOT NULL,
                "type" TEXT NOT NULL,
                "importDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "recordCount" INTEGER NOT NULL,
                "dateRangeStart" TIMESTAMP(3),
                "dateRangeEnd" TIMESTAMP(3),
                "logs" TEXT
            );

            CREATE TABLE IF NOT EXISTS "Invoice" (
                "id" SERIAL PRIMARY KEY,
                "invoiceDate" TIMESTAMP(3) NOT NULL,
                "paymentType" TEXT NOT NULL,
                "invoiceNumber" TEXT NOT NULL,
                "recipient" TEXT NOT NULL,
                "amount" DOUBLE PRECISION NOT NULL,
                "isReconciled" BOOLEAN NOT NULL DEFAULT false,
                "reconciledDate" TIMESTAMP(3),
                "manualStatus" BOOLEAN NOT NULL DEFAULT false,
                "comment" TEXT,
                "dunningStatus" TEXT,
                "dunningMethod" TEXT,
                "dunningDate" TIMESTAMP(3),
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP(3) NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

            CREATE TABLE IF NOT EXISTS "BankTransaction" (
                "id" SERIAL PRIMARY KEY,
                "bookingDate" TIMESTAMP(3) NOT NULL,
                "amount" DOUBLE PRECISION NOT NULL,
                "currency" TEXT NOT NULL DEFAULT 'EUR',
                "senderReceiver" TEXT,
                "description" TEXT,
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP(3) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS "BookingPayment" (
                "id" SERIAL PRIMARY KEY,
                "referenceNumber" TEXT NOT NULL,
                "checkInDate" TIMESTAMP(3) NOT NULL,
                "checkOutDate" TIMESTAMP(3) NOT NULL,
                "payoutDate" TIMESTAMP(3) NOT NULL,
                "amount" DOUBLE PRECISION NOT NULL,
                "currency" TEXT NOT NULL DEFAULT 'EUR',
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP(3) NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "BookingPayment_referenceNumber_key" ON "BookingPayment"("referenceNumber");

            CREATE TABLE IF NOT EXISTS "CardPayment" (
                "id" SERIAL PRIMARY KEY,
                "transactionDate" TIMESTAMP(3) NOT NULL,
                "cardType" TEXT NOT NULL,
                "amount" DOUBLE PRECISION NOT NULL,
                "grossAmount" DOUBLE PRECISION,
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMP(3) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS "ReconciliationMatch" (
                "id" SERIAL PRIMARY KEY,
                "invoiceId" INTEGER NOT NULL,
                "bankTransactionId" INTEGER,
                "bookingPaymentId" INTEGER,
                "cardPaymentId" INTEGER,
                "matchType" TEXT NOT NULL,
                "confidence" DOUBLE PRECISION,
                "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                
                CONSTRAINT "ReconciliationMatch_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
                CONSTRAINT "ReconciliationMatch_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE,
                CONSTRAINT "ReconciliationMatch_bookingPaymentId_fkey" FOREIGN KEY ("bookingPaymentId") REFERENCES "BookingPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE,
                CONSTRAINT "ReconciliationMatch_cardPaymentId_fkey" FOREIGN KEY ("cardPaymentId") REFERENCES "CardPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE
            );
        `);

        console.log('Tables created successfully!');
    } catch (err) {
        console.error('Error creating tables:', err);
    } finally {
        await client.end();
    }
}

createTables();
