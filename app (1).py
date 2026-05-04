import json, re, os
from flask import Flask, render_template, request, jsonify
import requests

app = Flask(__name__)
OLLAMA = os.getenv("OLLAMA_BASE", "http://localhost:11434")
MODEL  = os.getenv("OLLAMA_MODEL", "phi3")

# ─────────────────────────────────────────────────────────────────────────────
# CORE LLM CALL
# ─────────────────────────────────────────────────────────────────────────────
def ask(prompt: str, tokens: int = 300) -> str:
    r = requests.post(f"{OLLAMA}/api/generate", json={
        "model":  MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "num_predict": tokens,
            "temperature": 0.2,
            "top_p":       0.9,
            "repeat_penalty": 1.1,
        }
    }, timeout=120)
    r.raise_for_status()
    return r.json().get("response", "").strip()


# ─────────────────────────────────────────────────────────────────────────────
# PARSERS
# ─────────────────────────────────────────────────────────────────────────────
def _strip_md(text):
    text = re.sub(r"```[a-z]*\n?", "", text)
    return re.sub(r"```", "", text).strip()

def parse_list(raw):
    raw = _strip_md(raw)
    # Try full parse
    try:
        v = json.loads(raw)
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
    except Exception:
        pass
    # Try slicing [ ... ]
    a, b = raw.find("["), raw.rfind("]")
    if a != -1 and b > a:
        try:
            v = json.loads(raw[a:b+1])
            if isinstance(v, list):
                return [str(x).strip() for x in v if str(x).strip()]
        except Exception:
            pass
    # Quoted strings fallback
    quoted = re.findall(r'"([^"]{4,120})"', raw)
    if len(quoted) >= 2:
        return quoted
    # Line-by-line fallback
    lines = []
    for line in raw.splitlines():
        line = re.sub(r'^[\s\-\*\d\.\)\:]+', "", line).strip().strip('"').strip("'")
        if 4 < len(line) < 120:
            lines.append(line)
    return lines

def parse_obj(raw):
    raw = _strip_md(raw)
    for attempt in [raw, raw[raw.find("{"):raw.rfind("}")+1] if "{" in raw else ""]:
        try:
            v = json.loads(attempt)
            if isinstance(v, dict):
                return v
        except Exception:
            pass
    return {}

def clean_concepts(items, topic_lower=""):
    """Keep real named concepts — reject question starters and generic wrappers."""
    BAD = re.compile(
        r'^(how |what |why |when |where |who |which |'
        r'history of |future of |types of |introduction |overview |'
        r'definition of |meaning of |concept of )', re.I
    )
    seen, out = set(), []
    for item in items:
        item = str(item).strip().strip('"').strip("'")
        item = re.sub(r'^[\-\*\d\.\)\:]+\s*', "", item).strip()
        # Strip leading "the/a/an " but keep the rest
        item = re.sub(r'^(the|a|an)\s+', '', item, flags=re.I).strip()
        low = item.lower()
        # Allow short acronyms like ATP, RNA, DNA (len >= 2)
        if 1 < len(item) < 60 and low not in seen:
            if topic_lower and low in (topic_lower, topic_lower + "?"):
                continue
            if BAD.match(item):
                continue
            seen.add(low)
            out.append(item)
    return out

def clean_questions(items):
    """Keep only genuine questions that start with a question word and end with ?"""
    GOOD = re.compile(r'^(what|how|why|when|where|which|who|does|is|are|can|do)\b', re.I)
    # Generic template patterns to REJECT
    GENERIC = re.compile(
        r'^(what are the main components|why is .* significant|what triggers|'
        r'how does .* function in practice|what are .* used for|'
        r'what is the role of|what are the key|what are the primary)',
        re.I
    )
    seen, out = set(), []
    for item in items:
        item = str(item).strip().strip('"').strip("'")
        item = re.sub(r'^[\-\*\d\.\)\:]+\s*', "", item).strip()
        if not item.endswith("?"):
            item = item.rstrip(".!,") + "?"
        low = item.lower()
        if 12 < len(item) < 120 and low not in seen:
            if GOOD.match(item) and not GENERIC.match(item):
                seen.add(low)
                out.append(item)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# SHARED: generate questions grounded in topic facts
# The key fix for issue 2: we first ask the model for facts about the topic,
# THEN ask it to generate questions FROM those facts — prevents generic templates
# ─────────────────────────────────────────────────────────────────────────────
def generate_grounded_questions(topic, parent_topic="", n=5):
    # Step 1: get concrete facts about this specific topic
    facts_prompt = (
        f'List {n} specific, factual statements about "{topic}"'
        + (f' as it relates to "{parent_topic}"' if parent_topic else '') + '.\n'
        f'Each statement must contain a specific named fact, number, mechanism, or named entity.\n'
        f'No generic statements. Plain text, one per line:\n'
        f'1.'
    )
    raw_facts = ask(facts_prompt, 220)
    facts_lines = []
    for line in ('1.' + raw_facts).splitlines():
        line = re.sub(r'^[\s\d\.\)\-]+', '', line).strip()
        if len(line) > 15:
            facts_lines.append(line)
    facts_lines = facts_lines[:n]

    if not facts_lines:
        # Fallback: skip grounding, use direct topic-specific prompt
        return _direct_questions(topic, parent_topic, n)

    facts_block = '\n'.join(f'- {f}' for f in facts_lines)

    # Step 2: turn those specific facts into questions
    q_prompt = (
        f'Facts about "{topic}":\n{facts_block}\n\n'
        f'Write {n} questions that a curious student would ask, based ONLY on these facts.\n'
        f'Each question must reference something specific from the facts above.\n'
        f'Rules: start with What/How/Why/When/Where/Which/Can/Does/Is, end with ?, 8-18 words.\n'
        f'Output ONLY a JSON array of question strings:\n["'
    )
    raw_q = ask(q_prompt, 280)
    questions = parse_list('["' + raw_q)
    questions = clean_questions(questions)[:n]

    if len(questions) < 2:
        return _direct_questions(topic, parent_topic, n)

    return questions

def _direct_questions(topic, parent_topic, n):
    """Fallback: direct prompt but with strong anti-generic instructions."""
    p = (
        f'You are generating questions about "{topic}"'
        + (f' (part of {parent_topic})' if parent_topic else '') + '.\n'
        f'Write {n} specific questions. Each must:\n'
        f'- Reference a SPECIFIC aspect of "{topic}" by name\n'
        f'- NOT use these banned phrases: "main components", "significant", "function in practice", "triggers"\n'
        f'- Start with What/How/Why/When/Where/Which/Can/Does/Is\n'
        f'- End with ?\n'
        f'- Be 8-18 words\n'
        f'Output ONLY a JSON array:\n["'
    )
    raw = ask(p, 260)
    qs  = parse_list('["' + raw)
    return clean_questions(qs)[:n]


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/mixed", methods=["POST"])
def mixed_route():
    """
    Returns BOTH concepts and questions for a topic.
    Called on initial search AND when expanding a concept node.
    """
    topic = (request.json or {}).get("topic", "").strip()
    if not topic:
        return jsonify(error="no topic"), 400

    clean_topic = re.sub(
        r'^(what is|what are|how does|how do|explain|tell me about|describe|define)\s+',
        '', topic, flags=re.I
    )
    clean_topic = re.sub(r'[?!.]+$', '', clean_topic).strip()

    # ── Concepts: example-driven prompt so model knows exact format ──────────
    concept_prompt = (
        f'What are 5 specific named parts, mechanisms, or sub-fields of "{clean_topic}"?\n'
        f'Example — for "Photosynthesis": ["Light Reactions", "Calvin Cycle", "Chlorophyll", "Electron Transport", "Carbon Fixation"]\n'
        f'Now list 5 for "{clean_topic}". Output ONLY a JSON array of strings, nothing else:\n['
    )
    raw_c    = ask(concept_prompt, 200)
    # Model may or may not include the opening bracket
    raw_c    = raw_c if raw_c.startswith('[') else '[' + raw_c
    concepts = parse_list(raw_c)
    concepts = clean_concepts(concepts, topic_lower=clean_topic.lower())
    concepts = concepts[:5]

    if len(concepts) < 2:
        # Fallback attempt 1: plain comma-separated
        fb_prompt = (
            f'List 5 named parts of "{clean_topic}". Comma-separated. '
            f'Each 1-4 words. Real named things only. Not "{clean_topic}" itself.\n'
        )
        raw_fb = ask(fb_prompt, 140)
        fb = [p.strip().strip('"').strip("'") for p in raw_fb.split(",")]
        fb = clean_concepts(fb, topic_lower=clean_topic.lower())
        if len(fb) >= 2:
            concepts = fb[:5]

    # Guaranteed fallback: ask for numbered list, parse line by line
    if len(concepts) < 2:
        num_prompt = (
            f'Name 5 components of "{clean_topic}", numbered 1-5. One per line. Short names only.\n'
            f'1.'
        )
        raw_num = '1.' + ask(num_prompt, 120)
        for line in raw_num.splitlines():
            line = re.sub(r'^[\s\d\.\)\-]+', '', line).strip().strip('"').strip("'")
            if 2 < len(line) < 50 and line.lower() != clean_topic.lower():
                if not re.match(r'^(how|what|why|when|where|is|are|a |an |the )', line, re.I):
                    concepts.append(line)
        concepts = list(dict.fromkeys(concepts))[:5]  # deduplicate, keep order

    # ── Questions: grounded in real facts ────────────────────────────────────
    questions = generate_grounded_questions(clean_topic, parent_topic="", n=5)

    return jsonify(clean_topic=clean_topic, concepts=concepts, questions=questions)


@app.route("/api/questions", methods=["POST"])
def questions_route():
    """
    Given a concept node, returns specific grounded questions about it.
    Called as part of concept expansion (parallel with /api/mixed).
    """
    body    = request.json or {}
    concept = body.get("concept", "").strip()
    parent  = body.get("parent_topic", "").strip()
    if not concept:
        return jsonify(error="no concept"), 400

    questions = generate_grounded_questions(concept, parent_topic=parent, n=5)
    return jsonify(questions=questions)


@app.route("/api/answer", methods=["POST"])
def answer_route():
    """
    Answers a question node. Returns a complete 2-3 sentence answer.
    Answer becomes a dead-end node in the graph.
    """
    body     = request.json or {}
    question = body.get("question", "").strip()
    topic    = body.get("topic", "").strip()
    if not question:
        return jsonify(error="no question"), 400

    prompt = (
        f'Topic context: {topic}\n'
        f'Question: {question}\n\n'
        f'Give a complete, factual answer in exactly 2-3 sentences.\n'
        f'- Be specific and informative\n'
        f'- No bullet points, no headers, plain text only\n'
        f'- Stop after the 3rd sentence\n'
        f'Answer:\n'
    )
    # Enough tokens to finish 3 full sentences without truncation
    raw    = ask(prompt, 280)
    answer = re.sub(r'[#*_`>]+', '', raw).strip()

    # Trim to max 3 complete sentences — only cut at sentence boundary
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Z])', answer)
    answer = ' '.join(parts[:3]).strip()

    # If still no sentence end found, keep the whole thing (better than cutting mid-word)
    if not re.search(r'[.!?]$', answer):
        answer = answer  # keep as-is, it's a complete thought

    return jsonify(answer=answer, question=question)


@app.route("/api/edges", methods=["POST"])
def edges_route():
    """Edges between concept nodes only."""
    body      = request.json or {}
    topic     = body.get("topic", "")
    subtopics = body.get("subtopics", [])
    if len(subtopics) < 2:
        return jsonify(edges=[])

    idx_map    = {str(i): s for i, s in enumerate(subtopics)}
    index_list = "\n".join(f'{i}: {s}' for i, s in idx_map.items())

    prompt = (
        f'These are parts of "{topic}":\n{index_list}\n\n'
        f'Write 4-7 directed relationships. Format: FROM -> TO : label (2-3 words)\n'
        f'Use ONLY numbers 0 to {len(subtopics)-1}. One relationship per line.\n\n'
        f'Relationships:\n'
    )
    raw   = ask(prompt, 260)
    edges = []
    seen  = set()
    for line in raw.splitlines():
        m = re.match(r'\s*(\d+)\s*[-=]>\s*(\d+)\s*[:\-]?\s*(.*)', line)
        if m:
            si, di, label = m.group(1), m.group(2), m.group(3).strip()
            if si in idx_map and di in idx_map and si != di:
                key = f"{si}->{di}"
                if key not in seen:
                    seen.add(key)
                    edges.append({
                        "from": idx_map[si],
                        "to":   idx_map[di],
                        "label": (label or "relates to")[:28],
                    })
    return jsonify(edges=edges)


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)