from fastapi import FastAPI
from prompt_templates import suggest_prompt_templates
from prompt_score import rate_prompt_quality
from prompt_classifier import classify_llm_for_prompts  
from pydantic import BaseModel
from typing import List
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PromptRequest(BaseModel):
    prompt: str

class PromptListRequest(BaseModel):  
    prompts: List[str]

@app.post("/suggest-templates")
async def suggest_templates(request: PromptRequest):
    suggestions = suggest_prompt_templates(request.prompt)
    return {"templates": suggestions}

@app.post("/prompt-score")
async def get_prompt_score(request: PromptRequest):
    score = rate_prompt_quality(request.prompt)
    return {"score": score}

@app.post("/prompt_classifier") 
async def suggest_llm_model(request: PromptListRequest):
    result = classify_llm_for_prompts(request.prompts)
    return result

