import fs from 'fs';
import path from 'path';
import prisma from './db';

const MAX_AUTO_BACKUPS = 10;

function getBackupDir(): string {
    const baseDir = process.env.USER_DATA_PATH || path.join(__dirname, '..');
    const backupDir = path.join(baseDir, 'backups');
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
}

export async function createAutoBackup(): Promise<string | null> {
    try {
        const backupDir = getBackupDir();

        const invoices = await prisma.invoice.findMany({
            select: {
                id: true,
                invoiceNumber: true,
                invoiceDate: true,
                amount: true,
                amountPaid: true,
                status: true,
                isReconciled: true,
                reconciledDate: true,
                manualStatus: true,
                comment: true,
                dunningStatus: true
            }
        });

        const matches = await prisma.reconciliationMatch.findMany({
            select: {
                id: true,
                invoiceId: true,
                bankTransactionId: true,
                bookingPaymentId: true,
                cardPaymentId: true,
                pmsPaymentId: true,
                matchType: true,
                confidence: true
            }
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `auto_backup_${timestamp}.json`;
        const filePath = path.join(backupDir, filename);

        const data = {
            createdAt: new Date().toISOString(),
            invoicesCount: invoices.length,
            matchesCount: matches.length,
            invoices,
            matches
        };

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`[AutoBackup] Created snapshot: ${filename} (${invoices.length} invoices, ${matches.length} matches)`);

        // Rotate backups - keep last MAX_AUTO_BACKUPS
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('auto_backup_') && f.endsWith('.json'))
            .sort();

        if (files.length > MAX_AUTO_BACKUPS) {
            const toDelete = files.slice(0, files.length - MAX_AUTO_BACKUPS);
            for (const f of toDelete) {
                try {
                    fs.unlinkSync(path.join(backupDir, f));
                    console.log(`[AutoBackup] Rotated old backup: ${f}`);
                } catch {}
            }
        }

        return filePath;
    } catch (e) {
        console.error('[AutoBackup] Error creating auto-backup:', e);
        return null;
    }
}

export async function listAutoBackups(): Promise<{ filename: string; createdAt: string; invoicesCount: number; sizeBytes: number }[]> {
    try {
        const backupDir = getBackupDir();
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('auto_backup_') && f.endsWith('.json'))
            .sort()
            .reverse();

        return files.map(filename => {
            const fullPath = path.join(backupDir, filename);
            const stat = fs.statSync(fullPath);
            return {
                filename,
                createdAt: stat.mtime.toISOString(),
                invoicesCount: 0,
                sizeBytes: stat.size
            };
        });
    } catch {
        return [];
    }
}

export async function restoreLatestAutoBackup(): Promise<{ success: boolean; message: string; restoredCount?: number }> {
    try {
        const backupDir = getBackupDir();
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('auto_backup_') && f.endsWith('.json'))
            .sort()
            .reverse();

        if (files.length === 0) {
            return { success: false, message: 'Keine automatischen Backups gefunden.' };
        }

        const latestFile = path.join(backupDir, files[0]);
        const content = fs.readFileSync(latestFile, 'utf-8');
        const backup = JSON.parse(content);
        const invoices = backup.invoices || [];

        let updated = 0;
        const updates: any[] = [];

        for (const inv of invoices) {
            updates.push(prisma.invoice.updateMany({
                where: { invoiceNumber: inv.invoiceNumber },
                data: {
                    status: inv.status,
                    amountPaid: inv.amountPaid,
                    isReconciled: inv.isReconciled,
                    reconciledDate: inv.reconciledDate ? new Date(inv.reconciledDate) : null,
                    manualStatus: inv.manualStatus,
                    comment: inv.comment,
                    dunningStatus: inv.dunningStatus
                }
            }));
            updated++;
        }

        for (let i = 0; i < updates.length; i += 50) {
            await prisma.$transaction(updates.slice(i, i + 50));
        }

        return {
            success: true,
            message: `Zustand aus ${files[0]} erfolgreich wiederhergestellt! (${updated} Rechnungen aktualisiert)`,
            restoredCount: updated
        };
    } catch (e: any) {
        console.error('[AutoBackup] Error restoring latest backup:', e);
        return { success: false, message: `Wiederherstellung fehlgeschlagen: ${String(e)}` };
    }
}
