import React, { useState } from 'react';
import { api } from '../api';
import { Toast } from './Toast';
import type { ToastProps } from './Toast';

interface FileUploadProps {
    onUploadComplete?: () => void;
}

export const FileUpload: React.FC<FileUploadProps> = ({ onUploadComplete }) => {
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [progressText, setProgressText] = useState('');
    const [toast, setToast] = useState<Omit<ToastProps, 'onClose'> | null>(null);

    const showToast = (message: string, type: 'success' | 'error' | 'info') => {
        setToast({ message, type });
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        setUploading(true);
        setProgress(0);
        setProgressText('Lade Dateien hoch...');
        
        // Connect to progress stream before starting upload
        const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3010/api';
        const eventSource = new EventSource(`${API_URL}/progress/stream`);
        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setProgress(data.progress);
                setProgressText(data.message);
            } catch (err) {}
        };

        try {
            const fileArray = Array.from(files);
            const res = await api.uploadFiles(fileArray);
            
            const errorCount = res.results?.filter((r: any) => r.status === 'error').length || 0;
            const successCount = (res.results?.length || 0) - errorCount;

            if (errorCount > 0) {
                if (successCount === 0) {
                    showToast(`Upload fehlgeschlagen für ${errorCount} Datei(en). (Siehe Historie für Details)`, 'error');
                } else {
                    showToast(`Upload: ${successCount} erfolgreich, ${errorCount} fehlgeschlagen. (Siehe Historie)`, 'error');
                }
            } else {
                showToast(`Upload abgeschlossen! ${res.results.length} Datei(en) verarbeitet.`, 'success');
            }

            if (onUploadComplete) {
                onUploadComplete();
            }
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Upload fehlgeschlagen', 'error');
        } finally {
            eventSource.close();
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
                    color: 'white'
                }}>
                    <div style={{
                        background: 'white',
                        padding: '2rem',
                        borderRadius: '0.5rem',
                        boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
                        width: '80%',
                        maxWidth: '400px',
                        color: '#1f2937',
                        textAlign: 'center'
                    }}>
                        <div style={{ marginBottom: '1rem', fontWeight: 'bold' }}>Dateien werden verarbeitet...</div>
                        
                        {/* Progress Bar Container */}
                        <div style={{
                            width: '100%',
                            height: '1rem',
                            backgroundColor: '#e5e7eb',
                            borderRadius: '9999px',
                            overflow: 'hidden',
                            marginBottom: '0.5rem'
                        }}>
                            {/* Progress Bar Fill */}
                            <div style={{
                                width: `${progress}%`,
                                height: '100%',
                                backgroundColor: '#4f46e5',
                                transition: 'width 0.3s ease-out'
                            }} />
                        </div>
                        
                        <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                            {progressText}
                        </div>
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
