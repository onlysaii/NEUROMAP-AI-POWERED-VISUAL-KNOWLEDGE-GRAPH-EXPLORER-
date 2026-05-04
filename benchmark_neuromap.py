"""
NeuroMap Benchmark Script
Run: python benchmark_neuromap.py
Outputs real stats + a matplotlib chart saved as neuromap_benchmark.png
"""

import time, re, json, statistics, importlib.util, sys, os
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# ─── Load your app module without starting Flask ──────────────────────────────
# Assumes this script sits in the same folder as app.py
spec = importlib.util.spec_from_file_location("app", os.path.join(os.path.dirname(__file__), "app.py"))
mod  = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

ask               = mod.ask
parse_list        = mod.parse_list
parse_obj         = mod.parse_obj
clean_concepts    = mod.clean_concepts
clean_questions   = mod.clean_questions
generate_grounded_questions = mod.generate_grounded_questions

# ─── Test topics ──────────────────────────────────────────────────────────────
TOPICS = [
    "Photosynthesis",
    "Machine Learning",
    "The Solar System",
    "Human Immune System",
    "World War 2",
    "Blockchain",
    "Climate Change",
    "DNA Replication",
    "Quantum Computing",
    "The French Revolution",
]

# ─── Collectors ───────────────────────────────────────────────────────────────
results = {
    "topic": [],
    "concept_count": [],
    "concept_fallback_tier": [],   # 0=primary JSON, 1=comma, 2=numbered
    "question_count": [],
    "question_fallback": [],       # True if direct fallback was used
    "answer_sentence_count": [],
    "edge_parse_success": [],
    "latency_concept_ms": [],
    "latency_question_ms": [],
    "latency_answer_ms": [],
    "latency_edges_ms": [],
}

DUMMY_QUESTION = "What is the primary mechanism involved?"

print(f"\n{'='*60}")
print(f"  NeuroMap Benchmark  —  {len(TOPICS)} topics")
print(f"{'='*60}\n")

for topic in TOPICS:
    print(f"  Testing: {topic} ...", end=" ", flush=True)
    row = {}

    # ── 1. Concept generation (mirrors /api/mixed logic) ──────────────────
    t0 = time.time()
    concept_prompt = (
        f'What are 5 specific named parts, mechanisms, or sub-fields of "{topic}"?\n'
        f'Example — for "Photosynthesis": ["Light Reactions", "Calvin Cycle", "Chlorophyll", "Electron Transport", "Carbon Fixation"]\n'
        f'Now list 5 for "{topic}". Output ONLY a JSON array of strings, nothing else:\n['
    )
    raw_c = ask(concept_prompt, 200)
    raw_c = raw_c if raw_c.startswith('[') else '[' + raw_c
    concepts = parse_list(raw_c)
    concepts = clean_concepts(concepts, topic_lower=topic.lower())
    fallback_tier = 0

    if len(concepts) < 2:
        fallback_tier = 1
        fb_prompt = (
            f'List 5 named parts of "{topic}". Comma-separated. '
            f'Each 1-4 words. Real named things only.\n'
        )
        raw_fb = ask(fb_prompt, 140)
        fb = [p.strip().strip('"').strip("'") for p in raw_fb.split(",")]
        fb = clean_concepts(fb, topic_lower=topic.lower())
        if len(fb) >= 2:
            concepts = fb[:5]

    if len(concepts) < 2:
        fallback_tier = 2
        num_prompt = (
            f'Name 5 components of "{topic}", numbered 1-5. One per line. Short names only.\n1.'
        )
        raw_num = '1.' + ask(num_prompt, 120)
        for line in raw_num.splitlines():
            line = re.sub(r'^[\s\d\.\)\-]+', '', line).strip().strip('"').strip("'")
            if 2 < len(line) < 50 and line.lower() != topic.lower():
                concepts.append(line)
        concepts = list(dict.fromkeys(concepts))[:5]

    row["concept_count"]       = min(len(concepts), 5)
    row["concept_fallback_tier"] = fallback_tier
    row["latency_concept_ms"]  = int((time.time() - t0) * 1000)

    # ── 2. Question generation ─────────────────────────────────────────────
    t0 = time.time()
    questions = generate_grounded_questions(topic, n=5)
    row["question_count"]    = min(len(questions), 5)
    row["question_fallback"] = len(questions) < 2  # fell back to _direct_questions
    row["latency_question_ms"] = int((time.time() - t0) * 1000)

    # ── 3. Answer generation ──────────────────────────────────────────────
    t0 = time.time()
    answer_prompt = (
        f'Topic context: {topic}\nQuestion: {DUMMY_QUESTION}\n\n'
        f'Give a complete, factual answer in exactly 2-3 sentences.\n'
        f'No bullet points, no headers, plain text only.\nAnswer:\n'
    )
    raw_a  = ask(answer_prompt, 280)
    answer = re.sub(r'[#*_`>]+', '', raw_a).strip()
    parts  = re.split(r'(?<=[.!?])\s+(?=[A-Z])', answer)
    row["answer_sentence_count"] = min(len(parts), 3)
    row["latency_answer_ms"]     = int((time.time() - t0) * 1000)

    # ── 4. Edge parsing ───────────────────────────────────────────────────
    t0 = time.time()
    subtopics = concepts[:5] if concepts else ["A", "B", "C"]
    idx_map   = {str(i): s for i, s in enumerate(subtopics)}
    index_list = "\n".join(f'{i}: {s}' for i, s in idx_map.items())
    edge_prompt = (
        f'These are parts of "{topic}":\n{index_list}\n\n'
        f'Write 4-7 directed relationships. Format: FROM -> TO : label (2-3 words)\n'
        f'Use ONLY numbers 0 to {len(subtopics)-1}. One relationship per line.\n\nRelationships:\n'
    )
    raw_e = ask(edge_prompt, 260)
    edges_found = 0
    for line in raw_e.splitlines():
        m = re.match(r'\s*(\d+)\s*[-=]>\s*(\d+)\s*[:\-]?\s*(.*)', line)
        if m and m.group(1) in idx_map and m.group(2) in idx_map and m.group(1) != m.group(2):
            edges_found += 1
    row["edge_parse_success"]  = edges_found > 0
    row["latency_edges_ms"]    = int((time.time() - t0) * 1000)

    for k, v in row.items():
        results[k].append(v)

    total_ms = row["latency_concept_ms"] + row["latency_question_ms"] + row["latency_answer_ms"] + row["latency_edges_ms"]
    print(f"done  ({total_ms}ms total)")

# ─── Summary stats ────────────────────────────────────────────────────────────
n = len(TOPICS)

concept_success_rate  = sum(1 for c in results["concept_count"] if c >= 3) / n * 100
fallback_rate         = sum(1 for t in results["concept_fallback_tier"] if t > 0) / n * 100
question_success_rate = sum(1 for q in results["question_count"] if q >= 3) / n * 100
question_fallback_rate= sum(results["question_fallback"]) / n * 100
answer_quality_rate   = sum(1 for s in results["answer_sentence_count"] if s >= 2) / n * 100
edge_success_rate     = sum(results["edge_parse_success"]) / n * 100

avg_concept_lat  = statistics.mean(results["latency_concept_ms"])
avg_question_lat = statistics.mean(results["latency_question_ms"])
avg_answer_lat   = statistics.mean(results["latency_answer_ms"])
avg_edge_lat     = statistics.mean(results["latency_edges_ms"])
avg_total_lat    = avg_concept_lat + avg_question_lat + avg_answer_lat + avg_edge_lat

print(f"\n{'='*60}")
print(f"  Results Summary")
print(f"{'='*60}")
print(f"  Concept success rate  (≥3 concepts):   {concept_success_rate:.0f}%")
print(f"  Concept fallback rate (tier 1 or 2):   {fallback_rate:.0f}%")
print(f"  Question success rate (≥3 questions):  {question_success_rate:.0f}%")
print(f"  Question fallback rate:                {question_fallback_rate:.0f}%")
print(f"  Answer quality rate   (≥2 sentences):  {answer_quality_rate:.0f}%")
print(f"  Edge parse success rate:               {edge_success_rate:.0f}%")
print(f"\n  Avg latency — concept gen:   {avg_concept_lat:.0f} ms")
print(f"  Avg latency — question gen:  {avg_question_lat:.0f} ms")
print(f"  Avg latency — answer gen:    {avg_answer_lat:.0f} ms")
print(f"  Avg latency — edge parse:    {avg_edge_lat:.0f} ms")
print(f"  Avg latency — full expand:   {avg_total_lat:.0f} ms")
print(f"{'='*60}\n")

# ─── Chart ────────────────────────────────────────────────────────────────────
fig, axes = plt.subplots(1, 3, figsize=(15, 5))
fig.suptitle("NeuroMap — Pipeline Benchmark Results", fontsize=14, fontweight="bold", y=1.02)

BLUE  = "#378ADD"
AMBER = "#BA7517"
GREEN = "#639922"
RED   = "#E24B4A"
GRAY  = "#888780"

# ── Chart 1: Success rates ────────────────────────────────────────────────
ax1 = axes[0]
labels1 = ["Concept\ngen", "Question\ngen", "Answer\nquality", "Edge\nparse"]
values1 = [concept_success_rate, question_success_rate, answer_quality_rate, edge_success_rate]
colors1 = [GREEN if v >= 80 else AMBER if v >= 60 else RED for v in values1]
bars1   = ax1.bar(labels1, values1, color=colors1, width=0.5, edgecolor="white", linewidth=0.8)
ax1.set_ylim(0, 110)
ax1.set_ylabel("Success rate (%)", fontsize=10)
ax1.set_title("Route success rates", fontsize=11, fontweight="bold")
ax1.axhline(80, color=GRAY, linestyle="--", linewidth=0.8, alpha=0.6)
ax1.text(3.6, 81, "80% target", fontsize=8, color=GRAY)
for bar, val in zip(bars1, values1):
    ax1.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 1.5,
             f"{val:.0f}%", ha="center", va="bottom", fontsize=10, fontweight="bold")
ax1.spines[["top", "right"]].set_visible(False)

# ── Chart 2: Avg latency per route ────────────────────────────────────────
ax2 = axes[1]
labels2 = ["Concept\ngen", "Question\ngen", "Answer\ngen", "Edge\nparse"]
values2 = [avg_concept_lat, avg_question_lat, avg_answer_lat, avg_edge_lat]
colors2 = [BLUE, BLUE, GREEN, AMBER]
bars2   = ax2.bar(labels2, values2, color=colors2, width=0.5, edgecolor="white", linewidth=0.8)
ax2.set_ylabel("Avg latency (ms)", fontsize=10)
ax2.set_title("Avg latency per route", fontsize=11, fontweight="bold")
for bar, val in zip(bars2, values2):
    ax2.text(bar.get_x() + bar.get_width()/2, bar.get_height() + max(values2)*0.01,
             f"{val:.0f}ms", ha="center", va="bottom", fontsize=10, fontweight="bold")
ax2.spines[["top", "right"]].set_visible(False)

# ── Chart 3: Per-topic concept & question counts ──────────────────────────
ax3 = axes[2]
x      = np.arange(len(TOPICS))
width  = 0.35
short_labels = [t[:10] for t in TOPICS]
bars3a = ax3.bar(x - width/2, results["concept_count"],  width, label="Concepts",  color=BLUE,  edgecolor="white", linewidth=0.8)
bars3b = ax3.bar(x + width/2, results["question_count"], width, label="Questions", color=GREEN, edgecolor="white", linewidth=0.8)
ax3.set_xticks(x)
ax3.set_xticklabels(short_labels, rotation=40, ha="right", fontsize=8)
ax3.set_ylabel("Count (max 5)", fontsize=10)
ax3.set_title("Concepts & questions per topic", fontsize=11, fontweight="bold")
ax3.set_ylim(0, 7)
ax3.axhline(5, color=GRAY, linestyle="--", linewidth=0.8, alpha=0.5)
ax3.legend(fontsize=9)
ax3.spines[["top", "right"]].set_visible(False)

plt.tight_layout()
out_path = os.path.join(os.path.dirname(__file__), "neuromap_benchmark.png")
plt.savefig(out_path, dpi=150, bbox_inches="tight")
print(f"  Chart saved → {out_path}\n")
plt.show()