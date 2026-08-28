import { AnalysisResults } from "../lib/api";

interface FheResultsProps {
  results: AnalysisResults | null;
  loading: boolean;
}

export function FheResults({ results, loading }: FheResultsProps) {
  if (!results || results.total_participants === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">📊</div>
        <p>Henüz katılımcı yok. İlk anketi doldurun!</p>
      </div>
    );
  }

  const {
    plain_accuracy,
    fhe_accuracy,
    accuracy_drop,
    training_plain_accuracy,
    training_fhe_accuracy,
    total_participants,
    individual_results
  } = results;

  return (
    <div className="fhe-results">
      <div className="accuracy-grid">
        <div className="accuracy-card accuracy-card--plain">
          <div className="eyebrow">ŞİFRESİZ MODEL DOĞRULUĞU</div>
          <div className="accuracy-card__value">{(plain_accuracy * 100).toFixed(1)}%</div>
          <div className="accuracy-card__label">Geleneksel ML</div>
        </div>
        
        <div className="accuracy-card accuracy-card--fhe">
          <div className="eyebrow">ŞİFRELİ (FHE) MODEL DOĞRULUĞU</div>
          <div className="accuracy-card__value">{(fhe_accuracy * 100).toFixed(1)}%</div>
          <div className="accuracy-card__label">Zama Concrete ML</div>
        </div>
        
        <div className={`accuracy-card ${accuracy_drop > 0 ? "accuracy-card--warning" : "accuracy-card--success"}`}>
          <div className="eyebrow">DOĞRULUK KAYBI</div>
          <div className="accuracy-card__value">{(accuracy_drop * 100).toFixed(2)}%</div>
          <div className="accuracy-card__label">FHE Şifreleme Maliyeti</div>
        </div>
      </div>

      <div className="training-banner">
        <div className="eyebrow training-banner__title">EĞİTİM SETİ PERFORMANSI (1000 Sentetik Veri)</div>
        <div className="training-banner__item">
          <span>Şifresiz:</span>
          <span className="mono">{(training_plain_accuracy * 100).toFixed(1)}%</span>
        </div>
        <div className="training-banner__item">
          <span>FHE:</span>
          <span className="mono">{(training_fhe_accuracy * 100).toFixed(1)}%</span>
        </div>
      </div>

      <div className="results-table">
        <div className="results-table__head">
          <div className="eyebrow">BİREYSEL TAHMİNLER</div>
          <div className="tag">{total_participants} Katılımcı</div>
        </div>
        <table className="predictions-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Girdiler (X₁-X₁₁)</th>
              <th>Gerçek (y)</th>
              <th>Plain Tahmin</th>
              <th>FHE Tahmin</th>
              <th>Plain ✓/✗</th>
              <th>FHE ✓/✗</th>
            </tr>
          </thead>
          <tbody>
            {individual_results.map((res, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="mono predictions-table__inputs">
                  [{res.features.join(", ")}]
                </td>
                <td>{res.true_label}</td>
                <td>{res.plain_pred}</td>
                <td>{res.fhe_pred}</td>
                <td className={res.plain_correct ? "pred-correct" : "pred-wrong"}>
                  {res.plain_correct ? "✓" : "✗"}
                </td>
                <td className={res.fhe_correct ? "pred-correct" : "pred-wrong"}>
                  {res.fhe_correct ? "✓" : "✗"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
