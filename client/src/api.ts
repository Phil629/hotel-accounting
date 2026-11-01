export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3010/api';

export const api = {
    async uploadFiles(files: File[]) {
        const formData = new FormData();
        files.forEach(file => formData.append('files', file));

        const res = await fetch(`${API_URL}/upload`, {
            method: 'POST',
            body: formData
        });
        
        if (!res.ok) {
            let errorText = 'Upload failed';
            try {
                const errJson = await res.json();
                errorText = errJson.error || errorText;
            } catch {
                errorText = await res.text();
            }
            throw new Error(errorText);
        }
        
        return res.json();
    },

    async reconcile() {
        const res = await fetch(`${API_URL}/reconcile`, {
            method: 'POST'
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Reconciliation failed');
        }
        return res.json();
    },

    async getInvoices(months?: string[]) {
        const qs = months && months.length > 0 ? `?months=${months.join(',')}` : '';
        const res = await fetch(`${API_URL}/invoices${qs}`);
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to fetch invoices');
        }
        return res.json();
    },

    async toggleVerify(id: number, status: boolean) {
        const res = await fetch(`${API_URL}/invoices/${id}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
        return res.json();
    },

    updateComment: async (id: number, comment?: string, aiComment?: string) => {
        const res = await fetch(`${API_URL}/invoices/${id}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment, aiComment })
        });
        return res.json();
    },

    async updateDunning(id: number, status: string, method: string, date: string) {
        const res = await fetch(`${API_URL}/invoices/${id}/dunning`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, method, date })
        });
        return res.json();
    },

    async clearDatabase() {
        const res = await fetch(`${API_URL}/clear-db`, { 
            method: 'DELETE'
        });
        return res.json();
    },

    async getFiles() {
        const res = await fetch(`${API_URL}/files`);
        if (!res.ok) throw new Error('Failed to fetch files');
        return res.json();
    },

    async deleteMonth(month: string) {
        // month format: YYYY-MM
        const res = await fetch(`${API_URL}/invoices/by-month?month=${month}`, { 
            method: 'DELETE'
        });
        if (!res.ok) throw new Error('Failed to delete month');
        return res.json();
    },

    async getImportStatus() {
        const res = await fetch(`${API_URL}/import-status`);
        if (!res.ok) throw new Error('Failed to fetch import status');
        return res.json();
    },

    async downloadBackup() {
        const res = await fetch(`${API_URL}/backup`);
        if (!res.ok) throw new Error('Failed to download backup');
        return res.json();
    },

    async getClosedMonths(): Promise<string[]> {
        const res = await fetch(`${API_URL}/closed-months`);
        if (!res.ok) throw new Error('Failed to fetch closed months');
        return res.json();
    },

    async toggleCloseMonth(month: string, closed: boolean): Promise<{ success: boolean; closedMonths: string[] }> {
        const res = await fetch(`${API_URL}/closed-months`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ month, closed })
        });
        if (!res.ok) throw new Error('Failed to toggle month closure');
        return res.json();
    },

    async getBackups() {
        const res = await fetch(`${API_URL}/backups`);
        if (!res.ok) throw new Error('Failed to fetch backups');
        return res.json();
    },

    async restoreLatestBackup() {
        const res = await fetch(`${API_URL}/backups/restore-latest`, {
            method: 'POST'
        });
        if (!res.ok) throw new Error('Failed to restore latest backup');
        return res.json();
    },

    async checkInvoiceWithAI(id: number, apiKey?: string) {
        const res = await fetch(`${API_URL}/invoices/${id}/ai-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            if (text.includes('<!doctype') || text.includes('<html')) {
                throw new Error('Der Backend-Server wird gerade auf Render neu gestartet oder aktualisiert. Bitte 1-2 Minuten warten und erneut versuchen.');
            }
            throw new Error(text || 'Ungültige Server-Antwort');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'KI-Prüfung fehlgeschlagen');
        }
        return res.json();
    },

    async applyAiMatch(id: number, data: any) {
        const res = await fetch(`${API_URL}/invoices/${id}/ai-apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            if (text.includes('<!doctype') || text.includes('<html')) {
                throw new Error('Der Backend-Server wird gerade auf Render neu gestartet. Bitte kurz warten.');
            }
            throw new Error(text || 'Ungültige Server-Antwort');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Konnte Vorschlag nicht anwenden');
        }
        return res.json();
    }
};
