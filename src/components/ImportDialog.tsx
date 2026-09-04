import Papa from 'papaparse';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Alert, Modal } from './ui';

type ImportKind = 'users' | 'teams';

interface Preview {
  token: string;
  totalRows: number;
  creates: number;
  updates: number;
  rows: unknown[];
  errors: Array<{ row: number; field: string; message: string }>;
  expiresAt: string;
}

function mapRows(kind: ImportKind, records: Record<string, string>[]): unknown[] {
  if (kind === 'users') {
    return records.map((record) => {
      const rawGradeLevel = (record['年级'] ?? '').trim();
      const numericGradeLevel = Number(rawGradeLevel);
      return {
        studentNumber: record['学号'] ?? '',
        name: record['姓名'] ?? '',
        className: record['班级'] ?? '',
        gradeLevel:
          rawGradeLevel !== '' && Number.isFinite(numericGradeLevel)
            ? numericGradeLevel
            : rawGradeLevel,
      };
    });
  }
  return records.map((record) => ({
    name: record['团队名称'] ?? '',
    memberStudentNumbers: [
      record['成员1学号'] ?? '',
      record['成员2学号'] ?? '',
      record['成员3学号'] ?? '',
    ],
  }));
}

async function parseFile(file: File, kind: ImportKind): Promise<unknown[]> {
  try {
    if (file.name.toLowerCase().endsWith('.csv')) {
      const result = Papa.parse<Record<string, string>>(await file.text(), {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (header) => header.replace(/^\uFEFF/u, '').trim(),
      });
      if (result.errors.length > 0) throw new Error('CSV_PARSE_ERROR');
      return mapRows(kind, result.data);
    }
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) return [];
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, column) => {
      headers[column - 1] = String(cell.text)
        .replace(/^\uFEFF/u, '')
        .trim();
    });
    const records: Record<string, string>[] = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header] = row.getCell(index + 1).text.trim();
      });
      if (Object.values(record).some(Boolean)) records.push(record);
    }
    return mapRows(kind, records);
  } catch {
    throw new Error('文件解析失败，请检查 CSV/XLSX 格式');
  }
}

export function ImportDialog({
  kind,
  onClose,
  onImported,
}: {
  kind: ImportKind;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<unknown[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = kind === 'users' ? '/api/teacher/users' : '/api/teacher/teams';

  const validate = async () => {
    if (!file) {
      setError('请选择要导入的文件');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('文件不能超过 5 MiB');
      return;
    }
    if (!/\.(csv|xlsx)$/iu.test(file.name)) {
      setError('仅支持 CSV 或 XLSX 文件');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const parsedRows = await parseFile(file, kind);
      setRows(parsedRows);
      setPreview(
        await api<Preview>(`${base}/import/validate`, {
          method: 'POST',
          body: JSON.stringify({ rows: parsedRows }),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview || preview.errors.length > 0) return;
    setBusy(true);
    setError('');
    try {
      const response = await api<{ message: string }>(`${base}/import/commit`, {
        method: 'POST',
        body: JSON.stringify({ rows, token: preview.token }),
      });
      onImported(response.message);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t(kind === 'users' ? 'import.titleStudents' : 'import.titleTeams')}
      onClose={onClose}
      wide
    >
      <div className="import-dialog">
        {error ? <Alert message={error} /> : null}
        <label className="file-picker">
          <strong>{t('import.chooseFile')}</strong>
          <small>{t('import.dropHint')}</small>
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
            }}
          />
          {file ? <span>{file.name}</span> : null}
        </label>
        <div className="form-actions form-actions--spread">
          <a className="button button--ghost" href={`${base}/template.csv`}>
            {t('import.downloadTemplate')}
          </a>
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => void validate()}
          >
            {busy ? t('import.validating') : t('import.validate')}
          </button>
        </div>
        {preview ? (
          <section className="import-preview">
            <h3>{t('import.preview')}</h3>
            <div className="metric-grid metric-grid--compact">
              <div>
                <span>{t('import.totalRows')}</span>
                <strong>{preview.totalRows}</strong>
              </div>
              <div>
                <span>{t('import.creates')}</span>
                <strong>{preview.creates}</strong>
              </div>
              <div>
                <span>{t('import.updates')}</span>
                <strong>{preview.updates}</strong>
              </div>
              <div>
                <span>{t('import.errors')}</span>
                <strong>{preview.errors.length}</strong>
              </div>
            </div>
            {preview.errors.length ? (
              <>
                <Alert message={t('import.fixErrors')} />
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('import.row')}</th>
                        <th>{t('import.field')}</th>
                        <th>{t('import.message')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.errors.map((issue, index) => (
                        <tr key={`${issue.row}-${issue.field}-${index}`}>
                          <td>{issue.row}</td>
                          <td>{issue.field}</td>
                          <td>{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <Alert message={t('import.noErrors')} tone="success" />
            )}
            <details className="preview-rows">
              <summary>
                {t('import.totalRows')}: {preview.totalRows}
              </summary>
              {rows.slice(0, 20).map((row, index) => (
                <div key={index}>
                  {Object.values(row as Record<string, unknown>)
                    .flat()
                    .join(' · ')}
                </div>
              ))}
            </details>
            <div className="form-actions">
              <button type="button" className="button button--ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy || preview.errors.length > 0}
                onClick={() => void commit()}
              >
                {busy ? t('import.committing') : t('import.commit')}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
