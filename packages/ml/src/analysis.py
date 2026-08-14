import numpy as np
from sklearn.linear_model import LogisticRegression as SklearnLogisticRegression
from sklearn.metrics import accuracy_score
from concrete.ml.sklearn import LogisticRegression as FHELogisticRegression

def generate_synthetic_data(n_samples=1000, seed=42):
    np.random.seed(seed)
    
    # X1: social media hours (0-3)
    X1 = np.random.randint(0, 4, n_samples)
    # X2: comparison tendency (0-3)
    X2 = np.random.randint(0, 4, n_samples)
    # X3: phone before bed (0-1)
    X3 = np.random.randint(0, 2, n_samples)
    # X4: FOMO feeling (0-2)
    X4 = np.random.randint(0, 3, n_samples)
    # X5: notification stress (0-2)
    X5 = np.random.randint(0, 3, n_samples)
    # X6: nomophobia (0-2)
    X6 = np.random.randint(0, 3, n_samples)
    # X7: validation seeking (0-2)
    X7 = np.random.randint(0, 3, n_samples)
    # X8: phubbing (0-2)
    X8 = np.random.randint(0, 3, n_samples)
    # X9: doomscrolling (0-2)
    X9 = np.random.randint(0, 3, n_samples)
    # X10: self esteem impact (0-2)
    X10 = np.random.randint(0, 3, n_samples)
    # X11: distraction (0-2)
    X11 = np.random.randint(0, 3, n_samples)
    
    X = np.column_stack((X1, X2, X3, X4, X5, X6, X7, X8, X9, X10, X11)).astype(np.float64)
    
    # Higher values -> higher anxiety (weighted impact)
    scores = (X1 * 1.0) + (X2 * 1.5) + (X3 * 2.0) + (X4 * 1.5) + (X5 * 1.0) + \
             (X6 * 1.5) + (X7 * 1.0) + (X8 * 0.5) + (X9 * 2.0) + (X10 * 1.5) + (X11 * 1.0)
    
    median_score = np.median(scores)
    
    # y: anxiety level (0=calm, 1=high anxiety)
    y = (scores > median_score).astype(int)
    
    return X, y

class FHEAnalyzer:
    def __init__(self):
        print("Initializing FHEAnalyzer and generating synthetic data...")
        X, y = generate_synthetic_data()
        
        # Split train/test
        from sklearn.model_selection import train_test_split
        X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
        
        print("Training plain model...")
        self.plain_model = SklearnLogisticRegression()
        self.plain_model.fit(X_train, y_train)
        
        print("Training FHE model...")
        self.fhe_model = FHELogisticRegression(n_bits=8)
        self.fhe_model.fit(X_train, y_train)
        
        print("Compiling FHE model...")
        self.fhe_model.compile(X_train)
        
        self.training_plain_accuracy = accuracy_score(y_test, self.plain_model.predict(X_test))
        self.training_fhe_accuracy = accuracy_score(y_test, self.fhe_model.predict(X_test))
        
        print(f"Plain model test accuracy: {self.training_plain_accuracy:.4f}")
        print(f"FHE model test accuracy: {self.training_fhe_accuracy:.4f}")
        
        self.predictions = []

    def predict_single(self, features: list[int], true_label: int) -> dict:
        features_np = np.array([features], dtype=np.float64)
        
        plain_pred = int(self.plain_model.predict(features_np)[0])
        fhe_pred = int(self.fhe_model.predict(features_np, fhe="execute")[0])
        
        plain_correct = (plain_pred == true_label)
        fhe_correct = (fhe_pred == true_label)
        
        # FHE Kanıtı Oluştur (Cryptographic Proof)
        crypto_proof = None
        try:
            quantized = self.fhe_model.quantize_input(features_np)
            encrypted = self.fhe_model.fhe_circuit.encrypt(quantized)
            ser = encrypted.serialize()
            crypto_proof = {
                "is_encrypted": True,
                "ciphertext_size_bytes": len(ser),
                "ciphertext_hex": ser[:16].hex() + "..." + ser[-16:].hex(),
                "ciphertext_full_hex": ser.hex()
            }
        except Exception as e:
            print("Proof generation error:", e)
        
        result = {
            "plain_pred": plain_pred,
            "fhe_pred": fhe_pred,
            "true_label": true_label,
            "plain_correct": plain_correct,
            "fhe_correct": fhe_correct,
            "features": features,
            "crypto_proof": crypto_proof
        }
        self.predictions.append(result)
        return result

    def get_results(self) -> dict:
        total = len(self.predictions)
        if total == 0:
            return {
                "total_participants": 0,
                "plain_accuracy": 0.0,
                "fhe_accuracy": 0.0,
                "accuracy_drop": 0.0,
                "training_plain_accuracy": self.training_plain_accuracy,
                "training_fhe_accuracy": self.training_fhe_accuracy,
                "individual_results": []
            }
            
        plain_corrects = sum(1 for p in self.predictions if p["plain_correct"])
        fhe_corrects = sum(1 for p in self.predictions if p["fhe_correct"])
        
        plain_acc = plain_corrects / total
        fhe_acc = fhe_corrects / total
        
        return {
            "total_participants": total,
            "plain_accuracy": plain_acc,
            "fhe_accuracy": fhe_acc,
            "accuracy_drop": abs(plain_acc - fhe_acc),
            "training_plain_accuracy": self.training_plain_accuracy,
            "training_fhe_accuracy": self.training_fhe_accuracy,
            "individual_results": self.predictions
        }
