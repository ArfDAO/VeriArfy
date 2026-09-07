/**
 * Anket/ML servisinin adresi.
 *
 * Uretimde (Vercel) boyle bir servis YOK: `localhost:8000` sabit yazilinca
 * dagitik sitede her istek baglanti hatasiyla dusuyordu. Adres artik
 * `VITE_API_BASE` ile verilir; verilmezse yerel gelistirme adresine duser.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export interface SubmitData {
  social_media_hours: number;
  comparison: number;
  phone_before_bed: number;
  fomo: number;
  notification_stress: number;
  nomophobia: number;
  validation_seeking: number;
  phubbing: number;
  doomscrolling: number;
  self_esteem_impact: number;
  distraction: number;
  anxiety_level: number;
}

export interface CryptoProof {
  is_encrypted: boolean;
  ciphertext_size_bytes: number;
  ciphertext_hex: string;
  ciphertext_full_hex: string;
}

export interface PredictionResult {
  plain_pred: number;
  fhe_pred: number;
  true_label: number;
  plain_correct: boolean;
  fhe_correct: boolean;
  crypto_proof?: CryptoProof;
  results: AnalysisResults;
}

export interface AnalysisResults {
  total_participants: number;
  plain_accuracy: number;
  fhe_accuracy: number;
  accuracy_drop: number;
  training_plain_accuracy: number;
  training_fhe_accuracy: number;
  individual_results: Array<{
    features: number[];
    true_label: number;
    plain_pred: number;
    fhe_pred: number;
    plain_correct: boolean;
    fhe_correct: boolean;
  }>;
}

export interface StatsData {
  total_participants: number;
  is_model_ready: boolean;
  survey_open: boolean;
}

export async function submitSurvey(data: SubmitData): Promise<PredictionResult> {
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getResults(): Promise<AnalysisResults> {
  const res = await fetch(`${API_BASE}/api/results`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getStats(): Promise<StatsData> {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function closeSurvey(): Promise<AnalysisResults> {
  const res = await fetch(`${API_BASE}/api/close`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function resetSurvey(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/reset`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}
