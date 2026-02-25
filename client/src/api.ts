const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3010/api';

export const api = {
    async uploadFiles(files: File[]) {
        const formData = new FormData();
        files.forEach(file => formData.append('files', file));

        const res = await fetch(`${API_URL}/upload`, {
            method: 'POST',
            body: formData
        });
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

    async getInvoices() {
        const res = await fetch(`${API_URL}/invoices`);
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

    updateComment: async (id: number, comment: string) => {
        const res = await fetch(`${API_URL}/invoices/${id}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment })
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
        const res = await fetch(`${API_URL}/clear-db`, { method: 'DELETE' });
        return res.json();
    },

    async getFiles() {
        const res = await fetch(`${API_URL}/files`);
        if (!res.ok) throw new Error('Failed to fetch files');
        return res.json();
    },

    async deleteMonth(month: string) {
        // month format: YYYY-MM
        const res = await fetch(`${API_URL}/invoices/by-month?month=${month}`, { method: 'DELETE' });
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
    }
};
