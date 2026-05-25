import prisma from './db';
import { runReconciliation } from './reconciliation';

async function main() {
    console.log('--- Starting Rectification ---');

    // 1. Find all automatic card matches
    const autoCardMatches = await prisma.reconciliationMatch.findMany({
        where: { cardPaymentId: { not: null }, matchType: 'AUTOMATIC' },
        select: { id: true, invoiceId: true }
    });
    
    console.log(`Found ${autoCardMatches.length} automatic card matches.`);
    
    // 2. Delete them
    const deleted = await prisma.reconciliationMatch.deleteMany({
        where: { cardPaymentId: { not: null }, matchType: 'AUTOMATIC' }
    });
    console.log(`Deleted ${deleted.count} automatic card matches.`);

    // 3. Find invoices that were automatically reconciled but no longer have any matches
    // Only target those with manualStatus = false to protect user's manual work.
    const invoicesToReset = await prisma.invoice.findMany({
        where: {
            isReconciled: true,
            manualStatus: false,
            matches: { none: {} }
        },
        select: { id: true }
    });
    
    console.log(`Resetting isReconciled=false for ${invoicesToReset.length} invoices...`);
    
    if (invoicesToReset.length > 0) {
        await prisma.invoice.updateMany({
            where: { id: { in: invoicesToReset.map(i => i.id) } },
            data: { isReconciled: false, reconciledDate: null }
        });
    }

    console.log('--- Re-running Reconciliation ---');
    await runReconciliation();
    console.log(`Re-reconciliation completed.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
