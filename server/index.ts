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
        files: 10,                   // max 10 files per request
    },
    fileFilter: (_req, file, cb) => {
        if (!file.originalname.match(/\.(csv|txt)$/i)) {
            cb(new Error(`Unsupported file type: only .csv and .txt are accepted (got: ${file.originalname})`));
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

// Upload & parse CSV files
let sseClients: any[] = [];
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
} catch (fileErr: any) {
                console.error(`Error processing ${file.originalname}:`, fileErr);
                results.push({
                    filename:     file.originalname,
                    originalName: file.originalname,
                    status:       'error',
                    error:        fileErr.message
                });
            }
            processedCount++;
        }
        
        const finalData = JSON.stringify({ progress: 100, message: 'Upload abgeschlossen!' });
        sseClients.forEach(c => c.write(`data: ${finalData}\n\n`));

        res.json({ results });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'File upload failed' });
    }
});


