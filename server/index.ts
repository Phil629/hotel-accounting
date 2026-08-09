import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import prisma from './db';
import { processFile } from './parsers';
import { runReconciliation } from './reconciliation';

const app = express();
const port = process.env.PORT || 3010;

// ─── CORS (#16) ───────────────────────────────────────────────────────────────
// Allowed origins are configured via ALLOWED_ORIGINS env var (comma-separated).
// Default covers the Vite dev server and Netlify production.
// Example: ALLOWED_ORIGINS=https://hotel.example.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'https://rechnungsabgleich.netlify.app,http://localhost:5173,http://localhost:5180,http://localhost:3010,null')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no Origin header (curl, Postman, same-origin server calls)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error(`CORS: origin '${origin}' is not allowed`));
        }
    },
    credentials: true,
}));
app.use(express.json());

// ─── File Upload (#15) ────────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use Electron's user data path if available, otherwise local uploads folder
        const baseDir = process.env.USER_DATA_PATH || __dirname;
        const uploadDir = path.join(baseDir, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    },
});

const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50 MB per file
        files: 100,                   // max 10 files per request
    },
    fileFilter: (_req, file, cb) => {
        if (!file.originalname.match(/\.(csv|txt|pdf)$/i)) {
            cb(new Error(`Unsupported file type: only .csv, .txt and .pdf are accepted (got: ${file.originalname})`));
            return;
        }
        cb(null, true);
    },
});

// ─── Admin Auth (#4) ──────────────────────────────────────────────────────────
// Protects destructive endpoints. Set ADMIN_SECRET in your .env file.
// Requests must include the header:  x-admin-key: <your-secret>
function requireAdminKey(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
): void {
    const provided = req.headers['x-admin-key'];
    const expected = process.env.ADMIN_SECRET;
    if (!expected || provided !== expected) {
        res.status(403).json({ error: 'Forbidden: valid x-admin-key header required' });
        return;
    }
    next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// Run reconciliation & Progress Stream
export let sseClients: any[] = [];

// Upload & parse CSV files
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
            res.status(400).json({ error: 'No files uploaded' });
            return;
        }

        const results = [];
        const totalFiles = files.length;
        let processedCount = 0;

        for (const file of files) {
            try {
                const progress = Math.round((processedCount / totalFiles) * 100);
                const data = JSON.stringify({ progress, message: `Verarbeite Datei ${processedCount + 1} von ${totalFiles}: ${file.originalname}` });
                sseClients.forEach(c => c.write(`data: ${data}\n\n`));

                const result = await processFile(file.path);

                // Auto-rename: prefix with type + month + year for easy identification
                let newFilename = file.originalname;
                if (result.dateRangeStart) {
                    const month = result.dateRangeStart.toLocaleString('default', { month: 'short' });
                    const year  = result.dateRangeStart.getFullYear();
                    const type  = result.type === 'UNKNOWN' ? 'File' : result.type;
                    newFilename  = `${type}_${month}_${year}_${Date.now()}.csv`;
                    fs.renameSync(file.path, path.join(path.dirname(file.path), newFilename));
                }

                await prisma.importedFile.create({
                    data: {
                        filename:       file.originalname, // keep original for UNKNOWN
                        originalName:   file.originalname,
                        type:           result.type,
                        recordCount:    result.count,
                        dateRangeStart: result.dateRangeStart,
                        dateRangeEnd:   result.dateRangeEnd,
                        logs:           result.logs ? JSON.stringify(result.logs) : null,
                    },
                });

                results.push({
                    filename:     newFilename,
                    originalName: file.originalname,
                    status:       'processed',
                    type:         result.type,
                    count:        result.count,
                });
            } catch (e: any) {
                console.error(`Error processing ${file.originalname}:`, e);

                await prisma.importedFile.create({
                    data: {
                        filename:     file.originalname,
                        originalName: file.originalname,
                        type:         'ERROR',
                        recordCount:  0,
                        logs:         JSON.stringify([`Error: ${String(e)}`]),
                    },
                });

                results.push({ filename: file.originalname, status: 'error', error: String(e) });
            }
            processedCount++;
        }

        const finalData = JSON.stringify({ progress: 100, message: 'Upload abgeschlossen!' });
        sseClients.forEach(c => c.write(`data: ${finalData}\n\n`));

        res.json({ message: 'Files uploaded and processed', results });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to process uploads' });
    }
});

// List all imported files
app.get('/api/files', async (_req, res) => {
    try {
        const files = await prisma.importedFile.findMany({ orderBy: { importDate: 'desc' } });
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

// Import status grouped by month — used by the dashboard's status indicators.
// Keys are German locale month names ("November 2025") to match the frontend
// grouping in Dashboard.tsx which uses toLocaleDateString('de-DE', ...).
app.get('/api/import-status', async (_req, res) => {
    try {
        const files = await prisma.importedFile.findMany({ orderBy: { importDate: 'desc' } });

        const statusByMonth: Record<string, typeof files> = {};

        for (const file of files) {
            if (!file.dateRangeStart || !file.dateRangeEnd) continue;

            let current = new Date(
                new Date(file.dateRangeStart).getFullYear(),
                new Date(file.dateRangeStart).getMonth(),
                1,
            );
            const last = new Date(
                new Date(file.dateRangeEnd).getFullYear(),
                new Date(file.dateRangeEnd).getMonth(),
                1,
            );

            while (current <= last) {
                const key = current.toLocaleDateString('de-DE', { year: 'numeric', month: 'long' });
                if (!statusByMonth[key]) statusByMonth[key] = [];
                if (!statusByMonth[key].some(f => f.id === file.id)) {
                    statusByMonth[key].push(file);
                }
                current.setMonth(current.getMonth() + 1);
            }
        }

        res.json(statusByMonth);
    } catch (error) {
        console.error('Import status error:', error);
        res.status(500).json({ error: 'Failed to fetch import status' });
    }
});

// Run reconciliation

app.get('/api/progress/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

app.post('/api/reconcile', async (_req, res) => {
    try {
        const result = await runReconciliation((progress, message) => {
            const data = JSON.stringify({ progress, message });
            sseClients.forEach(c => c.write(`data: ${data}\n\n`));
        });
        res.json({ message: 'Reconciliation complete', matches: result });
    } catch (error) {
        console.error('Reconciliation error:', error);
        res.status(500).json({ error: 'Reconciliation failed' });
    }
});

// Get invoices — last 4 months + older months that still have open invoices.
// Optional ?months=YYYY-MM,YYYY-MM to force-load specific older months.
app.get('/api/invoices', async (req, res) => {
    try {
        const extraMonths = req.query.months
            ? (req.query.months as string).split(',')
            : [];

        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 3);
        cutoff.setDate(1);
        cutoff.setHours(0, 0, 0, 0);

        const orConditions: object[] = [
            { invoiceDate: { gte: cutoff } },
            { invoiceDate: { lt: cutoff }, isReconciled: false, manualStatus: false },
        ];

        for (const m of extraMonths) {
            const [year, mon] = m.split('-').map(Number);
            if (!isNaN(year) && !isNaN(mon) && mon >= 1 && mon <= 12) {
                orConditions.push({
                    invoiceDate: {
                        gte: new Date(year, mon - 1, 1),
                        lt:  new Date(year, mon,     1),
                    },
                });
            }
        }

        const invoices = await prisma.invoice.findMany({
            where:   { 
                status: { not: 'CANCELED' },
                OR: orConditions 
            },
            include: {
                matches: {
                    include: {
                        bookingPayment:  true,
                        cardPayment:     true,
                        bankTransaction: true,
                    },
                },
                pmsPayments: true,
                roomReservations: true,
            },
            orderBy: { invoiceDate: 'desc' },
        });

        res.json(invoices);
    } catch (error) {
        console.error('Error fetching invoices:', error);
        res.status(500).json({ error: 'Failed to fetch invoices', details: String(error) });
    }
});

// Delete all invoices (and their matches + imported files) for a given month.
// Query param: month=YYYY-MM
app.delete('/api/invoices/by-month', async (req, res) => {
    const { month } = req.query;
    if (!month || typeof month !== 'string') {
        res.status(400).json({ error: 'month query param required (YYYY-MM)' });
        return;
    }
    try {
        const [year, mon] = month.split('-').map(Number);
        const start = new Date(year, mon - 1, 1);
        const end   = new Date(year, mon,     1);

        const invoicesToDelete = await prisma.invoice.findMany({
            where:  { invoiceDate: { gte: start, lt: end } },
            select: { id: true },
        });
        const ids = invoicesToDelete.map(i => i.id);

        await prisma.$transaction([
            prisma.reconciliationMatch.deleteMany({ where: { invoiceId: { in: ids } } }),
            prisma.invoice.deleteMany({ where: { id: { in: ids } } }),
            prisma.importedFile.deleteMany({ where: { dateRangeStart: { gte: start, lt: end } } }),
            prisma.pmsPayment.deleteMany({ where: { paymentDate: { gte: start, lt: end } } }),
            prisma.bankTransaction.deleteMany({ where: { bookingDate: { gte: start, lt: end } } }),
            prisma.cardPayment.deleteMany({ where: { transactionDate: { gte: start, lt: end } } }),
            prisma.bookingPayment.deleteMany({ where: { payoutDate: { gte: start, lt: end } } }),
            prisma.roomReservation.deleteMany({ where: { checkIn: { gte: start, lt: end } } })
        ]);

        res.json({ success: true, deleted: ids.length });
    } catch (error) {
        console.error('Error deleting month:', error);
        res.status(500).json({ error: 'Failed to delete month' });
    }
});

// Manually verify / un-verify an invoice
app.post('/api/invoices/:id/verify', async (req, res) => {
    const invoiceId = parseInt(req.params.id, 10);
    const { status } = req.body;
    
    if (typeof status !== 'boolean') {
        res.status(400).json({ error: 'status must be a boolean' });
        return;
    }

    try {
        if (!status) {
            await prisma.reconciliationMatch.deleteMany({ where: { invoiceId } });
        }
        await prisma.invoice.update({
            where: { id: invoiceId },
            data:  { manualStatus: status, isReconciled: status, reconciledDate: status ? new Date() : null },
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// Update comment on an invoice
app.post('/api/invoices/:id/comment', async (req, res) => {
    try {
        await prisma.invoice.update({
            where: { id: parseInt(req.params.id) },
            data:  { comment: req.body.comment },
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update comment' });
    }
});

// Update dunning status on an invoice
app.post('/api/invoices/:id/dunning', async (req, res) => {
    const { status, method, date } = req.body;
    try {
        await prisma.invoice.update({
            where: { id: parseInt(req.params.id) },
            data:  {
                dunningStatus: status,
                dunningMethod: method,
                dunningDate:   date ? new Date(date) : null,
            },
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating dunning:', error);
        res.status(500).json({ error: 'Failed to update dunning status' });
    }
});

// JSON backup of all data (#17)
// Capped at BACKUP_ROW_CAP rows per table to prevent OOM on large datasets.
// The response includes a `truncated` flag when any table hit the cap.
// For a full database dump use pg_dump or a direct DB tool.
const BACKUP_ROW_CAP = 10_000;

app.get('/api/backup', async (_req, res) => {
    try {
        const [invoices, importedFiles, bookingPayments, cardPayments, bankTransactions, matches] =
            await Promise.all([
                prisma.invoice.findMany(           { take: BACKUP_ROW_CAP, orderBy: { id: 'desc' } }),
                prisma.importedFile.findMany(      { take: BACKUP_ROW_CAP, orderBy: { id: 'desc' } }),
                prisma.bookingPayment.findMany(    { take: BACKUP_ROW_CAP, orderBy: { id: 'desc' } }),
                prisma.cardPayment.findMany(       { take: BACKUP_ROW_CAP, orderBy: { id: 'desc' } }),
                prisma.bankTransaction.findMany(   { take: BACKUP_ROW_CAP, orderBy: { id: 'desc' } }),
                prisma.reconciliationMatch.findMany({ take: BACKUP_ROW_CAP, orderBy: { id: 'desc' } }),
            ]);

        const truncated =
            invoices.length          === BACKUP_ROW_CAP ||
            bookingPayments.length   === BACKUP_ROW_CAP ||
            cardPayments.length      === BACKUP_ROW_CAP ||
            bankTransactions.length  === BACKUP_ROW_CAP ||
            matches.length           === BACKUP_ROW_CAP;

        res.json({
            exportDate: new Date().toISOString(),
            version:    '1.0',
            truncated,
            ...(truncated && { rowCap: BACKUP_ROW_CAP, note: 'Use pg_dump for a complete export.' }),
            data: { invoices, importedFiles, bookingPayments, cardPayments, bankTransactions, matches },
        });
    } catch (error) {
        console.error('Error generating backup:', error);
        res.status(500).json({ error: 'Failed to generate backup' });
    }
});

// Wipe entire database — admin-key required (#4)
app.delete('/api/clear-db', async (_req, res) => {
    try {
        console.log('Clearing database...');
        // Delete in FK-safe order
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

// ─── Global Error Handler ─────────────────────────────────────────────────────
// Catches multer errors (file too large, wrong type) and CORS rejections so
// they return structured JSON instead of the default HTML error page.
app.use((
    err: Error,
    _req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _next: express.NextFunction,
) => {
    if (err instanceof multer.MulterError) {
        // e.g. LIMIT_FILE_SIZE, LIMIT_FILE_COUNT
        res.status(400).json({ error: `Upload rejected: ${err.message}` });
        return;
    }
    if (err.message?.startsWith('Unsupported file type')) {
        res.status(400).json({ error: err.message });
        return;
    }
    if (err.message?.startsWith('CORS:')) {
        res.status(403).json({ error: err.message });
        return;
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Serve Frontend (Electron / Production) ──────────────────────────────────
const isPackaged = __dirname.includes('app.asar');
const clientDistPath = isPackaged
    ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), '../../client/dist')
    : path.join(__dirname, '../../client/dist');

if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.use((req, res) => {
        res.sendFile(path.join(clientDistPath, 'index.html'));
    });
}


// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

