// app.js — orchestrates the 4-node-type knowledge graph

(function () {

  // ── State ──────────────────────────────────────────────────────────────────
  let currentTopic = '';   // clean topic label
  let answerCache  = {};   // questionId → answer text

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const searchScreen  = document.getElementById('search-screen');
  const graphScreen   = document.getElementById('graph-screen');
  const searchInput   = document.getElementById('search-input');
  const searchBtn     = document.getElementById('search-btn');
  const buildProgress = document.getElementById('build-progress');
  const buildBar      = document.getElementById('build-bar');
  const buildLabel    = document.getElementById('build-label');
  const toolbarTopic  = document.getElementById('toolbar-topic');
  const headerTopic   = document.getElementById('header-topic');
  const backBtn       = document.getElementById('back-btn');

  // ── Ollama status ─────────────────────────────────────────────────────────
  (async () => {
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
      document.getElementById('status-dot').classList.add(r.ok ? 'on' : 'err');
      document.getElementById('status-label').textContent = r.ok ? 'ollama ready' : 'ollama offline';
    } catch {
      document.getElementById('status-dot').classList.add('err');
      document.getElementById('status-label').textContent = 'ollama offline';
    }
  })();

  // ── Search ────────────────────────────────────────────────────────────────
  searchBtn.addEventListener('click', startSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') startSearch(); });
  window.quickSearch = t => { searchInput.value = t; startSearch(); };

  async function startSearch() {
    const topic = searchInput.value.trim();
    if (!topic) return;
    answerCache = {};

    searchScreen.classList.add('hidden');
    graphScreen.classList.remove('hidden');
    setProgress(5, 'Initialising...');
    buildProgress.classList.remove('done');

    KGraph.init(onNodeClick);

    // ── 1. Fetch concepts + questions together ────────────────────────────
    setProgress(15, 'Breaking down the topic...');
    let concepts = [], questions = [], cleanTopic = topic;
    try {
      const res  = await post('/api/mixed', { topic });
      concepts   = res.concepts   || [];
      questions  = res.questions  || [];
      cleanTopic = res.clean_topic || topic;
    } catch {
      concepts  = ['Core Mechanism', 'Key Components', 'Main Processes', 'Structural Elements'];
      questions = [
        `What are the main components of ${topic}?`,
        `How does ${topic} function in practice?`,
        `Why is ${topic} significant?`,
      ];
    }
    currentTopic = cleanTopic;
    toolbarTopic.textContent = cleanTopic;
    headerTopic.textContent  = cleanTopic;

    setProgress(38, `${concepts.length} concepts · ${questions.length} questions — drawing...`);

    // ── 2. Build node list ────────────────────────────────────────────────
    const centerNode = { id: cleanTopic, label: cleanTopic, type: 'center' };

    const conceptNodes = concepts.map(c => ({ id: c, label: c, type: 'concept' }));

    // Give each question a stable unique id
    const questionNodes = questions.map(q => ({
      id:    'q:' + q,
      label: q,
      type:  'question',
    }));

    const allNodes = [centerNode, ...conceptNodes, ...questionNodes];
    KGraph.setData(allNodes, []);

    // Star edges from center
    const starEdges = [
      ...concepts.map(c  => ({ from: cleanTopic, to: c,       label: '' })),
      ...questionNodes.map(n => ({ from: cleanTopic, to: n.id, label: '' })),
    ];
    KGraph.addEdges(starEdges);
    setProgress(55, 'Mapping concept relationships...');

    // ── 3. Edges between concepts only ───────────────────────────────────
    try {
      const res = await post('/api/edges', { topic: cleanTopic, subtopics: concepts });
      if (res.edges && res.edges.length) KGraph.addEdges(res.edges);
    } catch {}

    setProgress(100, 'Click a concept to expand · Click a question for an answer');
    setTimeout(() => buildProgress.classList.add('done'), 600);
  }

  // ── Node click dispatcher ─────────────────────────────────────────────────
  async function onNodeClick(node) {
    if (node.type === 'center')   return;              // center does nothing on click
    if (node.type === 'answer')   return;              // dead-end
    if (node.type === 'concept')  await expandConcept(node);
    if (node.type === 'question') await spawnAnswer(node);
  }

  // ── Expand concept → spawn sub-concepts AND questions in parallel ────────
  async function expandConcept(node) {
    buildProgress.classList.remove('done');
    setProgress(10, `Expanding "${node.label}"...`);

    try {
      // Fire both requests at the same time
      const [mixedRes, qRes] = await Promise.all([
        post('/api/mixed',     { topic: node.label }).catch(() => ({ concepts: [], questions: [] })),
        post('/api/questions', { concept: node.label, parent_topic: currentTopic }).catch(() => ({ questions: [] })),
      ]);

      setProgress(55, 'Adding nodes...');

      // Sub-concepts
      const rawConcepts = (mixedRes.concepts || []).filter(c => !KGraph.getNodeById(c));
      const newConceptNodes = rawConcepts.map(c => ({ id: c, label: c, type: 'concept' }));

      // Questions — merge from both responses, deduplicate
      const allRawQ = [...(mixedRes.questions || []), ...(qRes.questions || [])];
      const seen = new Set();
      const dedupedQ = allRawQ.filter(q => {
        const k = 'q:' + q;
        if (seen.has(k) || KGraph.getNodeById(k)) return false;
        seen.add(k);
        return true;
      });
      const newQuestionNodes = dedupedQ.map(q => ({ id: 'q:' + q, label: q, type: 'question' }));

      if (newConceptNodes.length === 0 && newQuestionNodes.length === 0) {
        setProgress(100, 'Already fully expanded');
        setTimeout(() => buildProgress.classList.add('done'), 500);
        return;
      }

      KGraph.addNodes([...newConceptNodes, ...newQuestionNodes]);
      KGraph.addEdges([
        ...rawConcepts.map(c => ({ from: node.id, to: c,        label: 'part of' })),
        ...dedupedQ.map(q   => ({ from: node.id, to: 'q:' + q, label: '' })),
      ]);

      // Edges between new sub-concepts
      if (rawConcepts.length >= 2) {
        try {
          const edgeRes = await post('/api/edges', { topic: node.label, subtopics: rawConcepts });
          if (edgeRes.edges && edgeRes.edges.length) KGraph.addEdges(edgeRes.edges);
        } catch {}
      }

      setProgress(100, `+${newConceptNodes.length} concepts · +${newQuestionNodes.length} questions`);
      setTimeout(() => buildProgress.classList.add('done'), 500);

    } catch (e) {
      console.error('expandConcept error:', e);
      buildProgress.classList.add('done');
    }
  }

  // ── Click question → spawn explanation node ───────────────────────────────
  async function spawnAnswer(node) {
    // Don't re-fetch if already answered
    if (answerCache[node.id]) return;

    buildProgress.classList.remove('done');
    setProgress(10, 'Generating answer...');

    try {
      const res = await post('/api/answer', {
        question: node.label,
        topic:    currentTopic,
      });
      const answer = res.answer || 'No answer available.';
      answerCache[node.id] = answer;

      // Spawn an answer node connected to this question
      const answerId = 'ans:' + node.id;
      if (!KGraph.getNodeById(answerId)) {
        KGraph.addNodes([{ id: answerId, label: answer, type: 'answer' }]);
        KGraph.addEdges([{ from: node.id, to: answerId, label: 'answer' }]);
      }

      setProgress(100, 'Answer loaded');
      setTimeout(() => buildProgress.classList.add('done'), 400);
    } catch (e) {
      console.error('spawnAnswer error:', e);
      buildProgress.classList.add('done');
    }
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    buildBar.style.width   = pct + '%';
    buildLabel.textContent = label;
  }

  // ── Back ──────────────────────────────────────────────────────────────────
  backBtn.addEventListener('click', () => {
    graphScreen.classList.add('hidden');
    searchScreen.classList.remove('hidden');
    buildProgress.classList.remove('done');
  });

  // ── Zoom controls ─────────────────────────────────────────────────────────
  document.getElementById('zoom-in-btn').addEventListener('click',    () => KGraph.zoomIn());
  document.getElementById('zoom-out-btn').addEventListener('click',   () => KGraph.zoomOut());
  document.getElementById('zoom-reset-btn').addEventListener('click', () => KGraph.zoomReset());
  document.getElementById('relayout-btn').addEventListener('click',   () => KGraph.relayout());

  // ── Fetch helper ──────────────────────────────────────────────────────────
  async function post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

})();