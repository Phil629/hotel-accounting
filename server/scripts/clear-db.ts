import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function clearDatabase() {
    console.log('Clearing database...');
    try {
        // Delete in order of dependencies (child first)
        await prisma.reconciliationMatch.deleteMany({});
        console.log('Deleted ReconciliationMatch');

        await prisma.invoice.deleteMany({});
        console.log('Deleted Invoice');

        await prisma.bookingPayment.deleteMany({});
        console.log('Deleted BookingPayment');

        await prisma.cardPayment.deleteMany({});
        console.log('Deleted CardPayment');

        await prisma.bankTransaction.deleteMany({});
        console.log('Deleted BankTransaction');

        await prisma.importedFile.deleteMany({});
        console.log('Deleted ImportedFile');

        console.log('Database cleared successfully.');
    } catch (e) {
        console.error('Error clearing database:', e);
    } finally {
        await prisma.$disconnect();
    }
}

clearDatabase();
