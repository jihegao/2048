import type { GradeLevel } from '../../shared/types';

export interface DbUser {
  id: string;
  login_id: string;
  role: 'teacher' | 'student';
  student_no: string | null;
  display_name: string;
  class_name: string | null;
  grade_level: GradeLevel | null;
  locale: 'zh-CN' | 'en' | null;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  credential_version: number;
  created_at: number;
  updated_at: number;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function roomCode(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => (byte % 36).toString(36).toUpperCase()).join('');
}

export function teamCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `T-${Array.from(bytes, (byte) => (byte % 36).toString(36).toUpperCase()).join('')}`;
}
