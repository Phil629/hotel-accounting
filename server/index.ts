import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { processFile } from './parsers';

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3010;

// Middleware
app.use(cors());
app.use(express.json());

// File Upload Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    },
});

const upload = multer({ storage });

// Routes
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Upload Endpoint
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const results = [];

        for (const file of files) {
            try {
                const result = await processFile(file.path);

                // Duplicate check removed to allow re-processing (upsert handles data deduplication)
                /*
                const existingFile = await prisma.importedFile.findFirst({
                    where: {
                        originalName: file.originalname,
                        type: result.type,
                        dateRangeStart: result.dateRangeStart,
                        dateRangeEnd: result.dateRangeEnd
                    },
                    orderBy: { importDate: 'desc' }
                });

                if (existingFile && existingFile.recordCount > 0) {
                    // ...
                }
                */

                // Auto-Rename Logic
                let newFilename = file.originalname;
                if (result.dateRangeStart) {
                    const month = result.dateRangeStart.toLocaleString('default', { month: 'short' });
                    const year = result.dateRangeStart.getFullYear();
                    const type = result.type === 'UNKNOWN' ? 'File' : result.type;
                    newFilename = `${type}_${month}_${year}_${Date.now()}.csv`;

                    const newPath = path.join(path.dirname(file.path), newFilename);
                    fs.renameSync(file.path, newPath);
                }

                // Save to DB
                await prisma.importedFile.create({
                    data: {
                        filename: newFilename,
                        originalName: file.originalname,
                        type: result.type,
                        recordCount: result.count,
                        dateRangeStart: result.dateRangeStart,
                        dateRangeEnd: result.dateRangeEnd,
                        logs: result.logs ? JSON.stringify(result.logs) : null
                    }
                });

                results.push({
                    filename: newFilename,
                    originalName: file.originalname,
                    status: 'processed',
                    type: result.type,
                    count: result.count
                });
            } catch (e) {
                console.error(`Error processing ${file.originalname}:`, e);

                // Save Error to DB History
                await prisma.importedFile.create({
                    data: {
                        filename: file.originalname,
                        originalName: file.originalname,
                        type: 'ERROR',
                        recordCount: 0,
                        logs: JSON.stringify([`Error processing file: ${String(e)}`])
                    }
                });

                results.push({
                    filename: file.originalname,
                    status: 'error',
                    error: String(e)
                });
            }
        }

        res.json({ message: 'Files uploaded and processed', results });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to process uploads' });
    }
});

// Get Uploaded Files
app.get('/api/files', async (req, res) => {
    try {
        const files = await prisma.importedFile.findMany({
            orderBy: { importDate: 'desc' }
        });
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

// Get Import Status by Month (Grouped list of files)
app.get('/api/import-status', async (req, res) => {
    try {
        const files = await prisma.importedFile.findMany({
            orderBy: { importDate: 'desc' }
        });

        // Group by month: { "2023-11": [File1, File2], ... }
        const statusByMonth: Record<string, any[]> = {};

        for (const file of files) {
            if (!file.dateRangeStart || !file.dateRangeEnd) continue;

            const startDate = new Date(file.dateRangeStart);
            const endDate = new Date(file.dateRangeEnd);

            // Iterate through months from start to end
            let currentDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
            const lastDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

            while (currentDate <= lastDate) {
                const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`; // e.g., "2025-11"
                // Format for UI (or keep this key and format in UI, let's keep consistent with existing key format)
                // Existing code used a separate 'month' formatted string in UI but keys were likely YYYY-MM based on the while loop in previous code?
                // Wait, previous code:
                /*
                const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
                */
                // But the UI used `month.toLocaleDateString` for display.
                // Let's stick to the key format "Month Year" (e.g., "November 2025") which seemed to be what the UI was using for `sortedMonths` keys in `Dashboard.tsx`.
                // Actually in `Dashboard.tsx`:
                /*
                 const date = new Date(inv.invoiceDate);
                 const monthKey = date.toLocaleDateString('de-DE', { year: 'numeric', month: 'long' });
                */
                // So the invoice grouping uses "November 2025".
                // The `importStatus` endpoint previously used `YYYY-MM`.
                // And `Dashboard.tsx` mapped `month` (from `sortedMonths` which are "November 2025") to... wait.
                // `Dashboard.tsx`:
                /*
                 const monthKey = month; // e.g., "2025-11"
                */
                // Wait, `sortedMonths` comes from `groupedInvoices`.
                // `groupedInvoices` keys are "Month Year" (German locale).
                // So `monthKey` in line 315 implies `month` is "Month Year".
                // BUT `importStatus` keys in previous server code were `YYYY-MM`.
                // So there was a mismatch! Or I missed something.
                // Let's re-read `Dashboard.tsx` line 315-316:
                /*
                 const monthKey = month; // e.g., "2025-11"
                 const status = importStatus[monthKey] || ...
                */
                // If `sortedMonths` are "November 2025", then `monthKey` is "November 2025".
                // If `importStatus` uses `YYYY-MM`, then `importStatus["November 2025"]` would be undefined.
                // Let's check `Dashboard.tsx` again.
                /*
                186: const monthKey = date.toLocaleDateString('de-DE', { year: 'numeric', month: 'long' });
                */
                // So `groupedInvoices` keys are "November 2025".
                // So `sortedMonths` are "November 2025".
                // So `importStatus` MUST accept "November 2025" keys OR the dashboard was broken/I misread.
                // Previous server code:
                /*
                167: const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
                */
                // That looks like "2025-11".
                // So the status indicators might have been broken, or I am misinterpreting `sortedMonths`.
                // The user wants "Month Year" grouping.
                // To avoid confusion, I will make the server return "Month Year" keys using German locale to match `Dashboard.tsx`.

                const monthName = currentDate.toLocaleDateString('de-DE', { year: 'numeric', month: 'long' });

                if (!statusByMonth[monthName]) {
                    statusByMonth[monthName] = [];
                }

                // Avoid duplicates in the list
                if (!statusByMonth[monthName].some((f: any) => f.id === file.id)) {
                    statusByMonth[monthName].push(file);
                }

                // Next month
                currentDate.setMonth(currentDate.getMonth() + 1);
            }
        }

        res.json(statusByMonth);
    } catch (error) {
        console.error('Import status error:', error);
        res.status(500).json({ error: 'Failed to fetch import status' });
    }
});

// Reconciliation Endpoint
import { runReconciliation } from './reconciliation';

app.post('/api/reconcile', async (req, res) => {
    try {
        const result = await runReconciliation();
        res.json({ message: 'Reconciliation complete', ...result });
    } catch (error) {
        console.error('Reconciliation error:', error);
        res.status(500).json({ error: 'Reconciliation failed' });
    }
});

// Get Invoices
app.get('/api/invoices', async (req, res) => {
    try {
        const invoices = await prisma.invoice.findMany({
            include: {
                matches: {
                    include: {
                        bookingPayment: true,
                        cardPayment: true,
                        bankTransaction: true
                    }
                }
            },
            orderBy: { invoiceDate: 'desc' }
        });
        res.json(invoices);
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ error: 'Failed to fetch invoices', details: String(error) });
    }
});

// Manual Verification
app.post('/api/invoices/:id/verify', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // boolean
    try {
        const invoiceId = parseInt(id);

        // If un-verifying (status = false), delete any existing matches
        if (!status) {
            await prisma.reconciliationMatch.deleteMany({
                where: { invoiceId: invoiceId }
            });
        }

        await prisma.invoice.update({
            where: { id: invoiceId },
            data: {
                manualStatus: status,
                isReconciled: status, // If manually verified, it's reconciled
                reconciledDate: status ? new Date() : null
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Update Comment
app.post('/api/invoices/:id/comment', async (req, res) => {
    const { id } = req.params;
    const { comment } = req.body;
    try {
        await prisma.invoice.update({
            where: { id: parseInt(id) },
            data: { comment }
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// Update Dunning Status
app.post('/api/invoices/:id/dunning', async (req, res) => {
    const { id } = req.params;
    const { status, method, date } = req.body;
    try {
        await prisma.invoice.update({
            where: { id: parseInt(id) },
            data: {
                dunningStatus: status,
                dunningMethod: method,
                dunningDate: date ? new Date(date) : null
            }
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating dunning:', error);
        res.status(500).json({ error: 'Failed to update dunning status' });
    }
});

// Clear Database (Dev/Test only)
app.delete('/api/clear-db', async (req, res) => {
    try {
        console.log('Clearing database via API...');
        await prisma.reconciliationMatch.deleteMany({});
        await prisma.invoice.deleteMany({});
        await prisma.bookingPayment.deleteMany({});
        await prisma.cardPayment.deleteMany({});
        await prisma.bankTransaction.deleteMany({});
        await prisma.importedFile.deleteMany({});
        console.log('Database cleared.');
        res.json({ success: true, message: 'Database cleared successfully' });
    } catch (error) {
        console.error('Error clearing database:', error);
        res.status(500).json({ error: 'Failed to clear database' });
    }
});

// Start Server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
