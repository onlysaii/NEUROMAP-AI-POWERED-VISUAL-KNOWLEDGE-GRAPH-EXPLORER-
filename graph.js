// graph.js — D3 knowledge graph with 4 node types: center, concept, question, answer

window.KGraph = (function () {

  // ── Colors ─────────────────────────────────────────────────────────────────
  const C = {
    center:   { stroke: '#60efff', fill: '#0a2a3a', glow: 'url(#glow-center)', r: 42 },
    concept:  { stroke: '#7ec8e3', fill: '#0b1f2e', glow: 'none',              r: 30 },
    question: { stroke: '#f0a500', fill: '#1e1500', glow: 'none',              r: 0  }, // diamond — r unused
    answer:   { stroke: '#4caf80', fill: '#051a10', glow: 'none',              r: 0  }, // rect — r unused
  };

  const EDGE_COLOR    = '#1a3550';
  const LABEL_FG      = '#c8dff0';
  const Q_SIZE        = 22;   // half-width of diamond
  const ANS_W         = 240;
  const ANS_H         = 100;

  // ── State ──────────────────────────────────────────────────────────────────
  let svg, g, sim, zoom;
  let nodes = [];
  let edges = [];
  let selectedId  = null;
  let onNodeClick = null;
  let W = 0, H = 0;

  // ── Init ───────────────────────────────────────────────────────────────────
  function init(clickCb) {
    onNodeClick = clickCb;
    nodes = []; edges = []; selectedId = null;

    svg = d3.select('#graph-svg');
    svg.selectAll('*').remove();

    const el = document.getElementById('graph-svg');
    W = el.clientWidth || window.innerWidth;
    H = el.clientHeight || window.innerHeight;

    const defs = svg.append('defs');

    // Arrow marker
    defs.append('marker')
      .attr('id','arrow').attr('viewBox','0 -4 8 8')
      .attr('refX', 28).attr('refY', 0)
      .attr('markerWidth', 5).attr('markerHeight', 5)
      .attr('orient','auto')
      .append('path').attr('d','M0,-4L8,0L0,4').attr('fill', EDGE_COLOR);

    // Glows
    function addGlow(id, blur) {
      const f = defs.append('filter').attr('id', id);
      f.append('feGaussianBlur').attr('stdDeviation', blur).attr('result','blur');
      const m = f.append('feMerge');
      m.append('feMergeNode').attr('in','blur');
      m.append('feMergeNode').attr('in','SourceGraphic');
    }
    addGlow('glow-center', 7);
    addGlow('glow-selected', 4);

    // Background
    const rg = defs.append('radialGradient').attr('id','bg').attr('cx','50%').attr('cy','50%').attr('r','70%');
    rg.append('stop').attr('offset','0%').attr('stop-color','#070d1a');
    rg.append('stop').attr('offset','100%').attr('stop-color','#030508');
    svg.append('rect').attr('width','100%').attr('height','100%').attr('fill','url(#bg)');

    // Dot grid
    const pat = defs.append('pattern').attr('id','dots').attr('width',34).attr('height',34).attr('patternUnits','userSpaceOnUse');
    pat.append('circle').attr('cx',17).attr('cy',17).attr('r',0.6).attr('fill','rgba(255,255,255,0.03)');
    svg.append('rect').attr('width','100%').attr('height','100%').attr('fill','url(#dots)');

    // Zoom
    zoom = d3.zoom().scaleExtent([0.08, 5]).on('zoom', e => g.attr('transform', e.transform));
    svg.call(zoom).on('dblclick.zoom', null);

    g = svg.append('g').attr('class','graph-root');
    g.append('g').attr('class','links-g');
    g.append('g').attr('class','link-labels-g');
    g.append('g').attr('class','nodes-g');

    svg.on('click', () => {
      selectedId = null;
      g.selectAll('.graph-node').classed('selected', false);
      g.selectAll('.node-shape').attr('filter', d => d.type === 'center' ? 'url(#glow-center)' : 'none');
    });
  }

  // ── Data API ───────────────────────────────────────────────────────────────
  function setData(newNodes, newEdges) { nodes = newNodes; edges = newEdges; render(); }

  function addNodes(more) {
    const ex = new Set(nodes.map(n => n.id));
    more.forEach(n => { if (!ex.has(n.id)) nodes.push(n); });
    render();
  }

  function addEdges(more) {
    const ex = new Set(edges.map(e => eKey(e)));
    more.forEach(e => {
      const k = `${e.from}→${e.to}`;
      if (!ex.has(k)) { edges.push({ source: e.from, target: e.to, label: e.label || '' }); ex.add(k); }
    });
    render();
  }

  function replaceEdges(newEdges) {
    edges = newEdges.map(e => ({ source: e.from || e.source, target: e.to || e.target, label: e.label || '' }));
    render();
  }

  function eKey(e) { return `${e.source?.id||e.source}→${e.target?.id||e.target}`; }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    if (!svg) return;

    const linksG      = g.select('.links-g');
    const linkLabelsG = g.select('.link-labels-g');
    const nodesG      = g.select('.nodes-g');

    // ── Links ──
    const lSel = linksG.selectAll('.graph-link').data(edges, eKey);
    lSel.exit().transition().duration(200).style('opacity',0).remove();
    const lEnter = lSel.enter().append('line')
      .attr('class','graph-link')
      .attr('stroke', EDGE_COLOR).attr('stroke-width', 1.2)
      .attr('marker-end','url(#arrow)').style('opacity',0);
    lEnter.transition().duration(350).style('opacity',1);
    const allLinks = lEnter.merge(lSel);

    // ── Link labels ──
    const lblSel = linkLabelsG.selectAll('.graph-link-label').data(edges, eKey);
    lblSel.exit().remove();
    lblSel.enter().append('text').attr('class','graph-link-label')
      .attr('fill','#2a4a6a').attr('font-size','8.5px').attr('text-anchor','middle')
      .style('pointer-events','none')
      .merge(lblSel).text(d => d.label || '');
    const allLbls = linkLabelsG.selectAll('.graph-link-label');

    // ── Nodes ──
    const nSel = nodesG.selectAll('.graph-node').data(nodes, d => d.id);
    nSel.exit().transition().duration(250).style('opacity',0).remove();

    const nEnter = nSel.enter().append('g')
      .attr('class', d => `graph-node type-${d.type}`)
      .attr('cursor', d => d.type === 'answer' ? 'default' : 'pointer')
      .style('opacity',0)
      .call(d3.drag()
        .on('start', dragStart)
        .on('drag',  dragging)
        .on('end',   dragEnd));
    nEnter.transition().duration(420).style('opacity',1);

    // ── Shape per type ──
    // CENTER: circle with halo
    const centerG = nEnter.filter(d => d.type === 'center');
    centerG.append('circle').attr('class','node-halo')
      .attr('r', 56).attr('fill','none')
      .attr('stroke', C.center.stroke).attr('stroke-width',0.5)
      .attr('stroke-dasharray','3,5').attr('opacity',0.2);
    centerG.append('circle').attr('class','node-shape')
      .attr('r', C.center.r)
      .attr('fill', C.center.fill).attr('stroke', C.center.stroke)
      .attr('stroke-width', 2.5).attr('filter', 'url(#glow-center)');

    // CONCEPT: circle
    nEnter.filter(d => d.type === 'concept').append('circle').attr('class','node-shape')
      .attr('r', C.concept.r)
      .attr('fill', C.concept.fill).attr('stroke', C.concept.stroke)
      .attr('stroke-width', 1.5);

    // QUESTION: diamond (rotated square)
    nEnter.filter(d => d.type === 'question').append('rect').attr('class','node-shape')
      .attr('x', -Q_SIZE).attr('y', -Q_SIZE)
      .attr('width', Q_SIZE*2).attr('height', Q_SIZE*2)
      .attr('rx', 3)
      .attr('transform','rotate(45)')
      .attr('fill', C.question.fill).attr('stroke', C.question.stroke)
      .attr('stroke-width', 1.5);

    // ANSWER: rounded rectangle — dead end
    const ansG = nEnter.filter(d => d.type === 'answer');
    ansG.append('rect').attr('class','node-shape')
      .attr('x', -ANS_W/2).attr('y', -ANS_H/2)
      .attr('width', ANS_W).attr('height', ANS_H)
      .attr('rx', 8).attr('ry', 8)
      .attr('fill', C.answer.fill).attr('stroke', C.answer.stroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '4,3');
    // "Answer" badge
    ansG.append('text')
      .attr('y', -ANS_H/2 + 11).attr('font-size','7px')
      .attr('fill', C.answer.stroke).attr('text-anchor','middle')
      .attr('letter-spacing','1px').text('ANSWER');

    // ── Labels per type ──
    // Center label
    nEnter.filter(d => d.type === 'center').append('text')
      .attr('class','node-label')
      .attr('fill', C.center.stroke).attr('font-size','13px').attr('font-weight','600')
      .attr('text-anchor','middle').attr('dominant-baseline','middle')
      .style('pointer-events','none')
      .each(function(d) { wrapLabel(d3.select(this), d.label, 14, 2, 0); });

    // Concept label
    nEnter.filter(d => d.type === 'concept').append('text')
      .attr('class','node-label')
      .attr('fill', LABEL_FG).attr('font-size','10px').attr('font-weight','500')
      .attr('text-anchor','middle').attr('dominant-baseline','middle')
      .style('pointer-events','none')
      .each(function(d) { wrapLabel(d3.select(this), d.label, 12, 2, 0); });

    // Question label — sits below diamond, not inside
    nEnter.filter(d => d.type === 'question').append('text')
      .attr('class','node-label')
      .attr('fill', C.question.stroke).attr('font-size','9px')
      .attr('text-anchor','middle').attr('y', Q_SIZE + 10)
      .style('pointer-events','none')
      .each(function(d) { wrapLabel(d3.select(this), d.label, 22, 3, Q_SIZE + 10); });

    // Answer label — dynamically wrapped inside the rect
    nEnter.filter(d => d.type === 'answer').append('text')
      .attr('class','node-label')
      .attr('fill', '#8ecfb0').attr('font-size','8px')
      .attr('text-anchor','middle')
      .style('pointer-events','none')
      .each(function(d) { wrapAnswerLabel(d3.select(this), d.label); });

    // ── Events ──
    nEnter
      .filter(d => d.type !== 'answer')
      .on('mouseenter', handleHover)
      .on('mousemove',  handleHoverMove)
      .on('mouseleave', handleHoverOut)
      .on('click',      handleClick);

    const allNodes = nEnter.merge(nSel);

    // Selection highlight
    allNodes.classed('selected', d => d.id === selectedId);
    allNodes.filter(d => d.id === selectedId).select('.node-shape')
      .attr('filter','url(#glow-selected)').attr('stroke-width', 2.5);
    allNodes.filter(d => d.id !== selectedId && d.type !== 'center').select('.node-shape')
      .attr('filter','none').attr('stroke-width', 1.5);

    // ── Simulation ──
    if (sim) sim.stop();

    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(edges).id(d => d.id)
        .distance(d => {
          const st = d.source?.type, tt = d.target?.type;
          if (st === 'center' || tt === 'center') return 180;
          if (st === 'question' || tt === 'question') return 120;
          if (tt === 'answer') return 140;
          return 140;
        })
        .strength(0.4))
      .force('charge', d3.forceManyBody().strength(d => d.type === 'answer' ? -180 : -450))
      .force('center', d3.forceCenter(W/2, H/2))
      .force('collision', d3.forceCollide(d => collideR(d) + 16))
      .alphaDecay(0.025)
      .on('tick', () => {
        allLinks
          .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        allLbls
          .attr('x', d => (d.source.x + d.target.x) / 2)
          .attr('y', d => (d.source.y + d.target.y) / 2);
        allNodes.attr('transform', d => `translate(${d.x},${d.y})`);
      });

    updateCounter();
  }

  // ── Collision radius by type ──────────────────────────────────────────────
  function collideR(d) {
    if (d.type === 'center')   return 60;
    if (d.type === 'concept')  return 38;
    if (d.type === 'question') return 42;
    if (d.type === 'answer')   return ANS_W / 2 + 14;
    return 30;
  }

  // ── Label wrap with tspan ─────────────────────────────────────────────────
  function wrapLabel(sel, text, maxChars, maxLines, baseY) {
    sel.selectAll('tspan').remove();
    if (!text) return;
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    words.forEach(w => {
      const test = cur ? cur + ' ' + w : w;
      if (test.length > maxChars && cur) { lines.push(cur); cur = w; }
      else cur = test;
    });
    if (cur) lines.push(cur);
    const display = lines.slice(0, maxLines);
    const lh = 12;
    const startDy = -(display.length - 1) * lh / 2;
    display.forEach((line, i) => {
      sel.append('tspan')
        .attr('x', 0)
        .attr('dy', i === 0 ? startDy + 'px' : lh + 'px')
        .text(line);
    });
  }

  // ── Answer label: dynamic height wrapping ────────────────────────────────
  function wrapAnswerLabel(sel, text) {
    sel.selectAll('tspan').remove();
    if (!text) return;
    const maxChars = 32;   // characters per line — fits ANS_W=240 at 8px
    const lineH    = 11;
    const maxLines = 8;    // up to 8 lines = plenty for 3 sentences
    const words    = text.split(' ');
    const lines    = [];
    let cur = '';
    words.forEach(w => {
      const test = cur ? cur + ' ' + w : w;
      if (test.length > maxChars && cur) { lines.push(cur); cur = w; }
      else cur = test;
    });
    if (cur) lines.push(cur);
    const display  = lines.slice(0, maxLines);
    // Vertically center the block inside the rect (account for ANSWER badge at top)
    const totalH   = display.length * lineH;
    const startY   = -totalH / 2 + lineH / 2 + 6; // +6 for badge offset
    display.forEach((line, i) => {
      sel.append('tspan')
        .attr('x', 0)
        .attr('dy', i === 0 ? startY + 'px' : lineH + 'px')
        .text(line);
    });
  }

  // ── Drag ──────────────────────────────────────────────────────────────────
  function dragStart(e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
  function dragging(e, d)  { d.fx = e.x; d.fy = e.y; }
  function dragEnd(e, d)   { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }

  // ── Tooltip ───────────────────────────────────────────────────────────────
  const tooltip = document.getElementById('tooltip');

  function handleHover(e, d) {
    g.selectAll('.graph-link').classed('highlighted', l =>
      (l.source?.id||l.source) === d.id || (l.target?.id||l.target) === d.id
    );
    const hint = d.type === 'question'
      ? 'Click to get explanation'
      : 'Click to expand — spawns concepts & questions';
    tooltip.innerHTML =
      `<strong>${d.label||d.id}</strong>` +
      `<div style="margin-top:5px;color:#5a8aaa;font-size:0.72rem">${hint}</div>`;
    tooltip.classList.add('show');
  }
  function handleHoverMove(e) {
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top  = (e.clientY - 10) + 'px';
  }
  function handleHoverOut() {
    tooltip.classList.remove('show');
    g.selectAll('.graph-link').classed('highlighted', false);
  }

  // ── Click ─────────────────────────────────────────────────────────────────
  function handleClick(e, d) {
    e.stopPropagation();
    selectedId = d.id;
    render();
    if (onNodeClick) onNodeClick(d);
  }

  // ── Zoom ──────────────────────────────────────────────────────────────────
  function zoomIn()    { svg.transition().call(zoom.scaleBy, 1.35); }
  function zoomOut()   { svg.transition().call(zoom.scaleBy, 0.74); }
  function zoomReset() {
    svg.transition().duration(600)
      .call(zoom.transform, d3.zoomIdentity.translate(W/2, H/2).scale(0.85).translate(-W/2, -H/2));
  }
  function relayout()  { if (sim) sim.alpha(0.7).restart(); }

  function updateNode(id, props) {
    const n = nodes.find(x => x.id === id);
    if (n) Object.assign(n, props);
  }

  function updateCounter() {
    const el = document.getElementById('node-counter');
    if (el) el.textContent = `${nodes.length} nodes · ${edges.length} edges`;
  }

  function getConnected(nodeId) {
    return edges
      .filter(e => (e.source?.id||e.source) === nodeId || (e.target?.id||e.target) === nodeId)
      .map(e => (e.source?.id||e.source) === nodeId ? (e.target?.id||e.target) : (e.source?.id||e.source));
  }

  function getNodeById(id) { return nodes.find(n => n.id === id); }

  return {
    init, setData, addNodes, addEdges, replaceEdges, updateNode,
    zoomIn, zoomOut, zoomReset, relayout,
    getConnected, getNodeById,
  };
})();