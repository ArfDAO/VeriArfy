import { useState } from "react";
import { useT } from "../lib/i18n";

export interface SurveyResult {
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

/**
 * Anketin on-chain (FHE) yolu icin puanlari.
 *
 * `AnxietyStudy.submit` tek bir grup + iki tamsayi puani bekler; anket ise 12
 * maddelik. Cevirim burada, sorularin yanibasinda durur ki bir madde
 * eklendiginde/olceginin degistiginde puanlama da guncellensin.
 */
export interface StudyScores {
  /** Maruziyet grubu: 0 = DUSUK, 1 = ORTA, 2 = YUKSEK kullanim. */
  group: number;
  /** Genel kaygi / etki yuku puani (0–15). */
  anxiety: number;
  /** Akut huzursuzluk-panik puani (0–6). */
  panic: number;
}

/** Puanlarin ust sinirlari — arayuzde yuzde gostermek icin. */
export const STUDY_SCORE_MAX = { anxiety: 15, panic: 6 } as const;

/**
 * 12 maddelik anketi calismanin `{group, anxiety, panic}` semasina cevirir.
 *
 * - **group**: 1. sorudaki gunluk kullanim suresi. Anketin kovalari (<1 / 1-3 /
 *   3-5 / 5+ saat) ile `@veriarfy/study`'deki USAGE_GROUPS kovalari (0-5 / 5-10 /
 *   10+ saat) birebir ortusmuyor; burada birincil karsilastirma (DUSUK vs YUKSEK)
 *   korunacak sekilde daraltiliyor.
 * - **anxiety** ve **panic** maddeleri **ayrik**: hicbir soru iki puana birden
 *   girmez, aksi halde iki olcek yapay olarak korele olurdu.
 */
export function toStudyScores(r: SurveyResult): StudyScores {
  const t = useT();
  const group = r.social_media_hours <= 1 ? 0 : r.social_media_hours === 2 ? 1 : 2;

  // Genel kaygi / islevsellik yuku.
  const anxiety =
    r.comparison + // 0–3
    r.phone_before_bed + // 0–1
    r.validation_seeking + // 0–2
    r.phubbing + // 0–2
    r.doomscrolling + // 0–2
    r.self_esteem_impact + // 0–2
    r.distraction + // 0–2
    r.anxiety_level; // 0–1  => toplam max 15

  // Akut huzursuzluk / panik belirtileri.
  const panic =
    r.fomo + // 0–2
    r.notification_stress + // 0–2
    r.nomophobia; // 0–2  => toplam max 6

  return { group, anxiety, panic };
}

interface SurveyProps {
  onComplete: (result: SurveyResult) => void;
  disabled?: boolean;
}

export function Survey({ onComplete, disabled }: SurveyProps) {
  const t = useT();
  const [answers, setAnswers] = useState<Partial<SurveyResult>>({});

  const isComplete = 
    answers.social_media_hours !== undefined &&
    answers.comparison !== undefined &&
    answers.phone_before_bed !== undefined &&
    answers.fomo !== undefined &&
    answers.notification_stress !== undefined &&
    answers.nomophobia !== undefined &&
    answers.validation_seeking !== undefined &&
    answers.phubbing !== undefined &&
    answers.doomscrolling !== undefined &&
    answers.self_esteem_impact !== undefined &&
    answers.distraction !== undefined &&
    answers.anxiety_level !== undefined;

  const handleSubmit = () => {
    if (isComplete) {
      onComplete(answers as SurveyResult);
    }
  };

  const setAnswer = (key: keyof SurveyResult, value: number) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="survey">
      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">01</span>
          <span className="survey-question__text">{t("Günde ortalama kaç saat sosyal medya kullanıyorsunuz?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "<1 saat", value: 0 },
            { label: "1-3 saat", value: 1 },
            { label: "3-5 saat", value: 2 },
            { label: "5+ saat", value: 3 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.social_media_hours === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("social_media_hours", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">02</span>
          <span className="survey-question__text">{t("Sosyal medyada başkalarının hayatlarını kendinizle kıyaslar mısınız?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hiç", value: 0 },
            { label: "Bazen", value: 1 },
            { label: "Sık Sık", value: 2 },
            { label: "Her zaman", value: 3 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.comparison === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("comparison", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">03</span>
          <span className="survey-question__text">{t("Uyumadan hemen önce yatakta sosyal medyaya bakar mısınız?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hayır", value: 0 },
            { label: "Evet", value: 1 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.phone_before_bed === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("phone_before_bed", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">04</span>
          <span className="survey-question__text">{t("Sosyal medyaya bakmadığınızda bir şeyleri kaçırıyor (FOMO) hissine kapılır mısınız?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hiç", value: 0 },
            { label: "Biraz", value: 1 },
            { label: "Çok fazla", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.fomo === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("fomo", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">05</span>
          <span className="survey-question__text">{t("Bildirim sesleri veya sürekli çevrimiçi olma zorunluluğu sizde stres yaratıyor mu?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hayır", value: 0 },
            { label: "Bazen", value: 1 },
            { label: "Kesinlikle", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.notification_stress === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("notification_stress", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">06</span>
          <span className="survey-question__text">{t("Telefonunuz yanınızda olmadığında veya şarjı bittiğinde panik/huzursuzluk (Nomofobi) hisseder misiniz?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hiç", value: 0 },
            { label: "Bazen", value: 1 },
            { label: "Kesinlikle", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.nomophobia === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("nomophobia", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">07</span>
          <span className="survey-question__text">{t("Sosyal medyada paylaştığınız bir içerik yeterince beğeni/etkileşim almadığında moraliniz bozulur mu?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hiç", value: 0 },
            { label: "Biraz", value: 1 },
            { label: "Çok fazla", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.validation_seeking === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("validation_seeking", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">08</span>
          <span className="survey-question__text">{t("Karşınızdaki insanlarla yüz yüze sohbet ederken bile sürekli telefonunuzu kontrol etme ihtiyacı duyar mısınız?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hayır", value: 0 },
            { label: "Bazen", value: 1 },
            { label: "Çoğu zaman", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.phubbing === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("phubbing", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">09</span>
          <span className="survey-question__text">{t("Olumsuz veya üzücü haberleri arka arkaya kaydırmaktan (doomscrolling) kendinizi alamadığınız olur mu?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hiç", value: 0 },
            { label: "Bazen", value: 1 },
            { label: "Sık Sık", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.doomscrolling === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("doomscrolling", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">10</span>
          <span className="survey-question__text">{t("Sosyal medyadaki gönderiler (filtreli fotoğraflar, lüks hayatlar vb.) kendinize olan güveninizi düşürüyor mu?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hayır", value: 0 },
            { label: "Biraz", value: 1 },
            { label: "Oldukça", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.self_esteem_impact === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("self_esteem_impact", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">11</span>
          <span className="survey-question__text">{t("Sosyal medya kullanımı nedeniyle işinize, okulunuza veya günlük sorumluluklarınıza odaklanmakta zorluk çekiyor musunuz?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Hayır", value: 0 },
            { label: "Bazen", value: 1 },
            { label: "Sık Sık", value: 2 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice ${answers.distraction === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("distraction", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey-divider">
        <span className="survey-divider__label">
          {t("HEDEF DEĞİŞKEN")}
        </span>
      </div>

      <div className="survey-question">
        <div className="survey-question__header">
          <span className="survey-question__num">12</span>
          <span className="survey-question__text">{t("Genel olarak gün içinde kendinizi ne kadar kaygılı (anksiyeteli) hissediyorsunuz?")}</span>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {[
            { label: "Sakinim", value: 0 },
            { label: "Yüksek Kaygılıyım", value: 1 },
          ].map((opt) => (
            <button
              key={opt.value}
              className={`choice choice--wide ${answers.anxiety_level === opt.value ? "choice--on" : ""}`}
              onClick={() => setAnswer("anxiety_level", opt.value)}
              disabled={disabled}
            >
              {t(opt.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="survey__footer">
        <button
          className="pill pill--primary"
          onClick={handleSubmit}
          disabled={!isComplete || disabled}
        >
          {disabled ? t("Gönderiliyor...") : t("Anketi Gönder")}
        </button>
      </div>
    </div>
  );
}
