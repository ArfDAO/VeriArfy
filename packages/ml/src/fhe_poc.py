import numpy as np
from sklearn.datasets import make_classification
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression as SklearnLogisticRegression
from sklearn.metrics import accuracy_score
from concrete.ml.sklearn import LogisticRegression as ConcreteLogisticRegression

def main():
    print("1. Sentetik veri seti üretiliyor...")
    # 1. Veri Üretimi
    # 5 özellikli, 2 sınıflı (0 veya 1), 1000 satırlık veri seti oluşturuyoruz.
    X, y = make_classification(
        n_samples=1000,
        n_features=5,
        n_informative=4,
        n_redundant=1,
        random_state=42
    )

    # Veriyi Eğitim (%80) ve Test (%20) olarak ayırıyoruz.
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    print("2. Şifresiz (Plaintext) model eğitiliyor...")
    # 2. Şifresiz Model (Plaintext)
    plain_clf = SklearnLogisticRegression(random_state=42)
    plain_clf.fit(X_train, y_train)
    y_pred_plain = plain_clf.predict(X_test)
    accuracy_plain = accuracy_score(y_test, y_pred_plain)

    print("3. Şifreli (FHE) model eğitiliyor ve FHE devresine dönüştürülüyor (compile)...")
    # 3. Şifreli Model (FHE / Concrete ML)
    # n_bits=8 kullanarak modeli kuantize ediyoruz.
    fhe_clf = ConcreteLogisticRegression(n_bits=8, random_state=42)
    fhe_clf.fit(X_train, y_train)
    
    # Modeli FHE işlemleri için derliyoruz (compile)
    # Eğitim verisi dağılımını kullanarak devreyi optimize eder.
    fhe_clf.compile(X_train)

    print("4. Şifreli çıkarım (Encrypted Inference) yapılıyor (Bu işlem biraz zaman alabilir)...")
    # 4. Şifreli Çıkarım (Encrypted Inference)
    # fhe='execute' parametresi arka planda veriyi şifreler, şifreli veride tahmin yapar ve sonucu çözer.
    y_pred_fhe = fhe_clf.predict(X_test, fhe="execute")
    accuracy_fhe = accuracy_score(y_test, y_pred_fhe)

    print("\n--- SONUÇLAR ---")
    # 5. Çıktı
    print(f"Plaintext Model Accuracy      : %{accuracy_plain * 100:.2f}")
    print(f"FHE Encrypted Model Accuracy  : %{accuracy_fhe * 100:.2f}")
    
    # Aradaki farkı hesaplayalım
    fark = abs(accuracy_plain - accuracy_fhe) * 100
    print(f"\nDoğruluk Kaybı (Accuracy Drop) : %{fark:.2f}")

if __name__ == "__main__":
    main()
