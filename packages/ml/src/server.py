import os
import json
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from src.analysis import FHEAnalyzer

app = FastAPI(title="VeriArfy FHE ML Survey API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Starting server...")
analyzer = FHEAnalyzer()
survey_open = True

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)
SUBMISSIONS_FILE = os.path.join(DATA_DIR, "submissions.json")

class SubmitRequest(BaseModel):
    social_media_hours: int = Field(..., ge=0, le=3)
    comparison: int = Field(..., ge=0, le=3)
    phone_before_bed: int = Field(..., ge=0, le=1)
    fomo: int = Field(..., ge=0, le=2)
    notification_stress: int = Field(..., ge=0, le=2)
    nomophobia: int = Field(..., ge=0, le=2)
    validation_seeking: int = Field(..., ge=0, le=2)
    phubbing: int = Field(..., ge=0, le=2)
    doomscrolling: int = Field(..., ge=0, le=2)
    self_esteem_impact: int = Field(..., ge=0, le=2)
    distraction: int = Field(..., ge=0, le=2)
    anxiety_level: int = Field(..., ge=0, le=1)

@app.post("/api/submit")
async def submit_survey(req: SubmitRequest):
    global survey_open
    if not survey_open:
        raise HTTPException(status_code=400, detail="Survey is closed")

    features = [
        req.social_media_hours,
        req.comparison,
        req.phone_before_bed,
        req.fomo,
        req.notification_stress,
        req.nomophobia,
        req.validation_seeking,
        req.phubbing,
        req.doomscrolling,
        req.self_esteem_impact,
        req.distraction
    ]
    
    result = analyzer.predict_single(features, req.anxiety_level)
    
    # Save submission
    submission_data = req.model_dump()
    submission_data["prediction_result"] = result
    
    submissions = []
    if os.path.exists(SUBMISSIONS_FILE):
        try:
            with open(SUBMISSIONS_FILE, "r") as f:
                submissions = json.load(f)
        except Exception:
            pass
            
    submissions.append(submission_data)
    with open(SUBMISSIONS_FILE, "w") as f:
        json.dump(submissions, f, indent=2)
        
    return {
        "prediction": result,
        "results": analyzer.get_results()
    }

@app.get("/api/results")
async def get_results():
    return analyzer.get_results()

@app.get("/api/stats")
async def get_stats():
    return {
        "total_participants": len(analyzer.predictions),
        "is_model_ready": True,
        "survey_open": survey_open
    }

@app.post("/api/close")
async def close_survey():
    global survey_open
    survey_open = False
    return analyzer.get_results()

@app.post("/api/reset")
async def reset_survey():
    global survey_open
    survey_open = True
    analyzer.predictions = []
    if os.path.exists(SUBMISSIONS_FILE):
        with open(SUBMISSIONS_FILE, "w") as f:
            json.dump([], f)
    return {"status": "reset"}
