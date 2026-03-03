"""
BGE-M3 Embedding Server with Dense + Sparse support.

Endpoints:
  POST /embed          - Dense embedding for single text
  POST /embed/batch    - Dense embeddings for batch of texts
  POST /embed/full     - Dense + Sparse embedding for single text
  POST /embed/batch/full - Dense + Sparse embeddings for batch of texts
  GET  /health         - Health check
"""

import os
import logging
from flask import Flask, request, jsonify
from FlagEmbedding import BGEM3FlagModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

MODEL_NAME = os.environ.get("MODEL_NAME", "BAAI/bge-m3")
MAX_LENGTH = int(os.environ.get("MAX_LENGTH", "8192"))
USE_GPU = os.environ.get("USE_GPU", "true").lower() in ("true", "1", "yes")

logger.info(f"Loading model: {MODEL_NAME} (max_length={MAX_LENGTH}, gpu={USE_GPU})")
model = BGEM3FlagModel(MODEL_NAME, use_fp16=USE_GPU, device="cuda" if USE_GPU else "cpu")
logger.info("Model loaded successfully")


def sparse_to_dict(lexical_weights):
    """Convert FlagEmbedding lexical_weights dict to {indices, values} format."""
    if not lexical_weights:
        return {"indices": [], "values": []}
    indices = [int(k) for k in lexical_weights.keys()]
    values = [float(v) for v in lexical_weights.values()]
    return {"indices": indices, "values": values}


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_NAME})


@app.route("/embed", methods=["POST"])
def embed():
    """Dense embedding for single text."""
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "text is required"}), 400

    result = model.encode(
        [text],
        max_length=MAX_LENGTH,
        return_dense=True,
        return_sparse=False,
        return_colbert_vecs=False,
    )
    embedding = result["dense_vecs"][0].tolist()
    return jsonify({"embedding": embedding})


@app.route("/embed/batch", methods=["POST"])
def embed_batch():
    """Dense embeddings for batch of texts."""
    data = request.get_json()
    texts = data.get("texts", [])
    if not texts:
        return jsonify({"error": "texts is required"}), 400

    result = model.encode(
        texts,
        max_length=MAX_LENGTH,
        return_dense=True,
        return_sparse=False,
        return_colbert_vecs=False,
    )
    embeddings = [vec.tolist() for vec in result["dense_vecs"]]
    return jsonify({"embeddings": embeddings})


@app.route("/embed/full", methods=["POST"])
def embed_full():
    """Dense + Sparse embedding for single text."""
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "text is required"}), 400

    result = model.encode(
        [text],
        max_length=MAX_LENGTH,
        return_dense=True,
        return_sparse=True,
        return_colbert_vecs=False,
    )
    dense = result["dense_vecs"][0].tolist()
    sparse = sparse_to_dict(result["lexical_weights"][0])
    return jsonify({"dense": dense, "sparse": sparse})


@app.route("/embed/batch/full", methods=["POST"])
def embed_batch_full():
    """Dense + Sparse embeddings for batch of texts."""
    data = request.get_json()
    texts = data.get("texts", [])
    if not texts:
        return jsonify({"error": "texts is required"}), 400

    result = model.encode(
        texts,
        max_length=MAX_LENGTH,
        return_dense=True,
        return_sparse=True,
        return_colbert_vecs=False,
    )
    dense = [vec.tolist() for vec in result["dense_vecs"]]
    sparse = [sparse_to_dict(lw) for lw in result["lexical_weights"]]
    return jsonify({"dense": dense, "sparse": sparse})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
