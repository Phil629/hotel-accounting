import React, { useState } from 'react';
import { api } from '../api';
import { Toast } from './Toast';
import type { ToastProps } from './Toast';

interface FileUploadProps {
    onUploadComplete?: () => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({ onUploadComplete }) => {
    const [uploading, setUploading] = useState(false);
    const [toast, setToast] = useState<Omit<ToastProps, 'onClose'> | null>(null);

    const showToast = (message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setUploading(true);
        try {
            const fileArray = Array.from(files);
            const res = await api.uploadFiles(fileArray);
            showToast(`Upload complete! Processed ${res.results.length} files.`, 'success');
            if (onUploadComplete) {
                onUploadComplete();
            }
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Upload failed', 'error');
        } finally {
            setUploading(false);
            e.target.value = '';
        }
    };

    return (
        <div className="card">
            <h2>Upload Files</h2>
            <input type="file" multiple accept=".csv" onChange={handleUpload} disabled={uploading} />
            {uploading && <p>Uploading...</p>}
            {toast && <Toast {...toast} onClose={() => setToast(null)} />}
        </div>
    );
};
