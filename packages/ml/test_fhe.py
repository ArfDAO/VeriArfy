import numpy as np
from concrete.ml.sklearn import LogisticRegression
from sklearn.datasets import make_classification

X, y = make_classification(n_samples=100, n_features=5, random_state=42)
model = LogisticRegression(n_bits=8)
model.fit(X, y)
model.compile(X)

features = np.array([X[0]])
print("Plain prediction:", model.predict(features))

quantized_features = model.quantize_input(features)
print("Quantized:", quantized_features)

try:
    encrypted = model.fhe_circuit.encrypt(quantized_features)
    print("Encrypted type:", type(encrypted))
    
    # how to get size?
    import sys
    print("Encrypted size bytes:", sys.getsizeof(encrypted))
    
    # how to serialize?
    ser = encrypted.serialize()
    print("Serialized length:", len(ser))
    print("Serialized snippet:", ser[:50])
    
    res_enc = model.fhe_circuit.run(encrypted)
    res_dec = model.fhe_circuit.decrypt(res_enc)
    out = model.dequantize_output(res_dec)
    print("Decrypted output:", out)
except Exception as e:
    print("Error:", e)
