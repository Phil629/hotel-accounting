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
            showToast(`Upload abgeschlossen! ${res.results.length} Datei(en) verarbeitet.`, 'success');
            if (onUploadComplete) {
                onUploadComplete();
            }
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Upload fehlgeschlagen', 'error');
        } finally {
            setUploading(false);
            e.target.value = '';
        }
    };

    return (
        <>
            {/* Blocking overlay during upload */}
            {uploading && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    zIndex: 9999,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '1rem',
                    color: 'white',
                    fontSize: '1.2rem',
                    fontWeight: 'bold'
                }}>
                    <div style={{
                        width: '48px', height: '48px',
                        border: '5px solid rgba(255,255,255,0.3)',
                        borderTopColor: 'white',
                        borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite'
                    }} />
                    <div>Dateien werden hochgeladen...</div>
                    <div style={{ fontSize: '0.9rem', opacity: 0.8, fontWeight: 'normal' }}>
                        Bitte warten und nicht wegklicken.
                    </div>
                </div>
            )}

            <div className="card">
                <h2>Upload Files</h2>
                <input type="file" multiple accept=".csv" onChange={handleUpload} disabled={uploading} />
                {toast && <Toast {...toast} onClose={() => setToast(null)} />}
            </div>
        </>
    );
};
