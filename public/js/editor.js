const urlParams = new URLSearchParams(window.location.search);
const docId = urlParams.get('id');
let currentFormat = 'docx';
let saveTimeout = null;

if (!docId) {
    window.location.href = '/dashboard.html';
}

// Click outside export menu closes it
document.addEventListener('click', function(event) {
    if (!event.target.closest('.export-dropdown')) {
        document.getElementById('export-menu').style.display = 'none';
    }
});

async function loadDoc() {
    try {
        const res = await fetch(`/api/docs/${docId}`);
        if (!res.ok) throw new Error('Not found');
        const doc = await res.json();
        
        document.getElementById('doc-title').value = doc.title;
        currentFormat = doc.format || 'docx';
        switchFormat(currentFormat, false);
        
        if (currentFormat === 'tex') {
            document.getElementById('latex-textarea').value = doc.content || '';
        } else {
            document.getElementById('editor-content').innerHTML = doc.content || '';
        }
    } catch(err) {
        window.location.href = '/dashboard.html';
    }
}

function execCmd(command, value = null) {
    document.execCommand(command, false, value);
    document.getElementById('editor-content').focus();
    queueSave();
}

function htmlToLatex(html) {
    let text = html;
    text = text.replace(/<h1>(.*?)<\/h1>/gi, '\\section{$1}');
    text = text.replace(/<h2>(.*?)<\/h2>/gi, '\\subsection{$1}');
    text = text.replace(/<b>(.*?)<\/b>/gi, '\\textbf{$1}');
    text = text.replace(/<strong>(.*?)<\/strong>/gi, '\\textbf{$1}');
    text = text.replace(/<i>(.*?)<\/i>/gi, '\\textit{$1}');
    text = text.replace(/<em>(.*?)<\/em>/gi, '\\textit{$1}');
    text = text.replace(/<u>(.*?)<\/u>/gi, '\\underline{$1}');
    text = text.replace(/<ul>(.*?)<\/ul>/gi, '\\begin{itemize}\n$1\n\\end{itemize}');
    text = text.replace(/<li>(.*?)<\/li>/gi, '\\item $1');
    text = text.replace(/<div>(.*?)<\/div>/gi, '$1\n');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<p>(.*?)<\/p>/gi, '$1\n\n');
    text = text.replace(/<[^>]+>/g, ''); // strip remaining
    
    // Add boilerplate if missing
    if (!text.includes('\\begin{document}')) {
        text = `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\n\\title{${document.getElementById('doc-title').value || 'Document'}}\n\\begin{document}\n\\maketitle\n\n${text.trim()}\n\n\\end{document}`;
    }
    return text;
}

function latexToHtml(tex) {
    let html = tex;
    // Extract body if boilerplate exists
    const bodyMatch = html.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
    if (bodyMatch) {
        html = bodyMatch[1];
        // Remove maketitle so it doesn't leak into html
        html = html.replace(/\\maketitle/g, '');
    }
    
    html = html.replace(/\\section\{(.*?)\}/g, '<h1>$1</h1>');
    html = html.replace(/\\subsection\{(.*?)\}/g, '<h2>$1</h2>');
    html = html.replace(/\\textbf\{(.*?)\}/g, '<b>$1</b>');
    html = html.replace(/\\textit\{(.*?)\}/g, '<i>$1</i>');
    html = html.replace(/\\underline\{(.*?)\}/g, '<u>$1</u>');
    html = html.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, '<ul>$1</ul>');
    html = html.replace(/\\item (.*?)(?=\\item|\n|$)/g, '<li>$1</li>');
    
    // Handle newlines
    html = html.trim().split('\n\n').map(p => {
        if (p.trim() === '' || p.startsWith('<h') || p.startsWith('<ul>') || p.startsWith('<li')) return p;
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    
    return html;
}

function switchFormat(format, convert = true) {
    currentFormat = format;
    document.getElementById('btn-docx').classList.toggle('active', format === 'docx');
    document.getElementById('btn-tex').classList.toggle('active', format === 'tex');
    
    if (format === 'tex') {
        document.getElementById('editor-tools').style.display = 'none';
        document.getElementById('editor-content').style.display = 'none';
        document.getElementById('latex-textarea').style.display = 'block';
        if (convert) {
            const html = document.getElementById('editor-content').innerHTML;
            document.getElementById('latex-textarea').value = htmlToLatex(html);
            queueSave();
        }
    } else {
        document.getElementById('editor-tools').style.display = 'flex';
        document.getElementById('editor-content').style.display = 'block';
        document.getElementById('latex-textarea').style.display = 'none';
        if (convert) {
            const text = document.getElementById('latex-textarea').value;
            document.getElementById('editor-content').innerHTML = latexToHtml(text);
            queueSave();
        }
    }
}

function getDocContent() {
    if (currentFormat === 'tex') {
        return document.getElementById('latex-textarea').value;
    }
    return document.getElementById('editor-content').innerHTML;
}

function queueSave() {
    document.getElementById('save-status').innerText = 'Unsaved changes...';
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveDoc, 1000);
}

async function saveDoc() {
    const title = document.getElementById('doc-title').value;
    const content = getDocContent();
    document.getElementById('save-status').innerText = 'Saving...';
    
    await fetch(`/api/docs/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, format: currentFormat })
    });
    
    document.getElementById('save-status').innerText = 'All changes saved.';
    setTimeout(() => { if (document.getElementById('save-status').innerText === 'All changes saved.') document.getElementById('save-status').innerText = ''; }, 3000);
}

async function deleteDoc() {
    if (confirm('Are you sure you want to delete this document?')) {
        await fetch(`/api/docs/${docId}`, { method: 'DELETE' });
        window.location.href = '/dashboard.html';
    }
}

function exportDoc(type) {
    document.getElementById('export-menu').style.display = 'none';
    window.open(`/api/export/${docId}/${type}`, '_blank');
}

function applyAIEdit(newContent) {
    if (currentFormat === 'tex') {
        document.getElementById('latex-textarea').value = newContent;
    } else {
        document.getElementById('editor-content').innerHTML = newContent;
    }
    queueSave();
}

// AI Integration
async function sendAI() {
    const input = document.getElementById('ai-input');
    const msg = input.value.trim();
    if(!msg) return;
    
    const chatBox = document.getElementById('chat-box');
    
    // Add user msg
    const userDiv = document.createElement('div');
    userDiv.className = 'chat-msg chat-user';
    userDiv.innerText = msg;
    chatBox.appendChild(userDiv);
    input.value = '';
    
    // Add loading AI msg
    const aiDiv = document.createElement('div');
    aiDiv.className = 'chat-msg chat-ai';
    aiDiv.innerText = 'Thinking...';
    chatBox.appendChild(aiDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    const content = getDocContent();
    
    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, documentContent: content })
        });
        const data = await res.json();
        
        if (data.error) {
            aiDiv.innerText = data.error;
            return;
        }

        aiDiv.innerText = data.reply;
        
        if (data.edits) {
            const editBtn = document.createElement('button');
            editBtn.className = 'btn secondary';
            editBtn.style = 'margin-top: 8px; width: 100%; font-size: 13px;';
            editBtn.innerText = 'Apply AI Edit';
            editBtn.onclick = () => {
                applyAIEdit(data.edits);
                editBtn.innerText = '✓ Applied';
                editBtn.disabled = true;
            };
            aiDiv.appendChild(editBtn);
        }

    } catch(err) {
        aiDiv.innerText = "Connection error.";
    }
    chatBox.scrollTop = chatBox.scrollHeight;
}

loadDoc();

// --- Ghost Text Autocomplete Logic ---
let autocompleteTimeout = null;
let currentGhostPrediction = "";
const editorContentElement = document.getElementById('editor-content');

editorContentElement.addEventListener('keydown', (e) => {
    const ghostSpan = document.getElementById('ghost-text-span');
    if (e.key === 'Tab' && ghostSpan) {
        e.preventDefault(); // Stop tab from moving focus
        
        const parent = ghostSpan.parentNode;
        
        // Remove span
        ghostSpan.remove();
        
        // Insert prediction as real text exactly where the span was
        const textNode = document.createTextNode(currentGhostPrediction);
        
        // Use Selection API to put text and move caret
        const sel = window.getSelection();
        if (sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        
        currentGhostPrediction = "";
        queueSave();
    } else if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Meta') {
        if (ghostSpan) ghostSpan.remove();
    }
});

editorContentElement.addEventListener('input', (e) => {
    clearTimeout(autocompleteTimeout);
    const ghostSpan = document.getElementById('ghost-text-span');
    if (ghostSpan) ghostSpan.remove();
    
    // Only fetch if we are in DOCX visual mode and have text
    if (currentFormat !== 'docx') return;
    
    const text = editorContentElement.innerText.trim();
    if (text.length > 5) {
        // Wait 1.2 seconds of no typing before showing auto-complete
        autocompleteTimeout = setTimeout(fetchAutocomplete, 1200);
    }
});

async function fetchAutocomplete() {
    // Grab text from the editor to send to AI
    const contextText = editorContentElement.innerText.slice(-300); // Last 300 chars
    if (!contextText.trim()) return;
    
    try {
        const res = await fetch('/api/ai/autocomplete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contextText })
        });
        const data = await res.json();
        
        if (data.prediction && data.prediction.trim().length > 0) {
            let ghostSpan = document.getElementById('ghost-text-span');
            if (ghostSpan) ghostSpan.remove();
            
            currentGhostPrediction = data.prediction;
            
            ghostSpan = document.createElement('span');
            ghostSpan.id = 'ghost-text-span';
            ghostSpan.style = 'color: #a0a0a5; pointer-events: none; -webkit-user-modify: read-only;';
            ghostSpan.contentEditable = "false";
            ghostSpan.innerText = currentGhostPrediction;
            
            const sel = window.getSelection();
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            
            // Insert after current caret
            range.insertNode(ghostSpan);
            
            // Move caret right before the ghost span so typing deletes it and continues seamlessly
            range.setStartBefore(ghostSpan);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
    } catch(err) { console.error('Autocomplete Error:', err); }
}

// --- Versions Modal Logic ---
async function showVersions() {
    document.getElementById('versions-modal').style.display = 'block';
    const list = document.getElementById('versions-list');
    list.innerHTML = 'Loading versions...';
    try {
        const res = await fetch(`/api/documents/${docId}/versions`);
        const versions = await res.json();
        list.innerHTML = '';
        if (versions.length === 0) {
            list.innerHTML = '<p>No versions saved yet. The document is saved automatically as you edit.</p>';
            return;
        }
        for (let v of versions) {
            const div = document.createElement('div');
            div.style = 'border-bottom: 1px solid var(--border); padding: 12px 0; display: flex; justify-content: space-between; align-items: center;';
            const left = document.createElement('div');
            left.innerText = new Date(v.created_at).toLocaleString();
            
            const btnGroup = document.createElement('div');
            
            const right = document.createElement('button');
            right.className = 'btn secondary';
            right.innerText = 'Restore';
            right.onclick = () => restoreVersion(v.id);

            const delBtn = document.createElement('button');
            delBtn.className = 'btn secondary';
            delBtn.style.color = '#ff4d4f';
            delBtn.style.marginLeft = '8px';
            delBtn.innerText = 'Delete';
            delBtn.onclick = () => {
                deleteVersion(v.id);
            };
            
            btnGroup.appendChild(right);
            btnGroup.appendChild(delBtn);

            div.appendChild(left);
            div.appendChild(btnGroup);
            list.appendChild(div);
        }
    } catch(err) {
        list.innerHTML = 'Error loading versions.';
    }
}

async function restoreVersion(vid) {
    if (!confirm('Are you sure you want to restore this version? Current changes will be overwritten.')) return;
    try {
        const res = await fetch(`/api/documents/${docId}/versions/${vid}`);
        const data = await res.json();
        if (currentFormat === 'tex') {
            document.getElementById('latex-textarea').value = data.content;
        } else {
            document.getElementById('editor-content').innerHTML = data.content;
        }
        saveDoc();
        document.getElementById('versions-modal').style.display = 'none';
        alert('Version restored!');
    } catch(err) {
        alert('Error restoring version.');
    }
}

// --- Citation Manager Logic ---
function showCitations() {
    document.getElementById('cite-modal').style.display = 'block';
    document.getElementById('cite-result').style.display = 'none';
    document.getElementById('cite-result').value = '';
    document.getElementById('cite-insert-btn').style.display = 'none';
    document.getElementById('cite-input').value = '';
}

async function fetchCitation() {
    const query = document.getElementById('cite-input').value;
    if (!query) return;
    document.getElementById('cite-result').style.display = 'block';
    document.getElementById('cite-result').value = 'Generating BibTeX via Llama 3...';
    try {
        const res = await fetch('/api/ai/cite', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ query })
        });
        const data = await res.json();
        const bib = data.bibtex.replace(/```(bibtex)?|`/g, '').trim(); 
        document.getElementById('cite-result').value = bib;
        document.getElementById('cite-insert-btn').style.display = 'block';
    } catch(err) {
        document.getElementById('cite-result').value = 'Error generating citation.';
    }
}

function insertCitation() {
    const bib = document.getElementById('cite-result').value;
    if (!bib) return;
    
    if (currentFormat === 'tex') {
        const tex = document.getElementById('latex-textarea');
        tex.value = tex.value + '\n\n% Auto-generated by DocuLock Cite:\n' + bib + '\n';
    } else {
        const ed = document.getElementById('editor-content');
        ed.innerHTML += `<br><br><b>[BibTeX]</b><br><pre>${bib.replace(/\n/g, '<br>')}</pre><br>`;
    }
    document.getElementById('cite-modal').style.display = 'none';
    saveDoc();
}

// Ensure versions are saved occasionally when saveDoc is called.
// We'll wrap saveDoc to also push to versions api occasionally or user handles it via history saving.
let lastVersionTime = 0;
const originalSaveDoc = saveDoc;
saveDoc = async function() {
    await originalSaveDoc();
    // After basic save, every 2 minutes or manually trigger version push
    const now = Date.now();
    if (now - lastVersionTime > 120000) {
        lastVersionTime = now;
        const content = currentFormat === 'tex' ? document.getElementById('latex-textarea').value : document.getElementById('editor-content').innerHTML;
        fetch(`/api/documents/${docId}/versions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ content })
        });
    }
};


// --- AI Presets ---
function applyPreset(tone) {
    const aiInput = document.getElementById('ai-input');
    aiInput.value = `Please revise this document to make the tone more ${tone}.`;
    sendAI();
}

// --- Zen Mode ---
let isZenMode = false;
function toggleZen() {
    isZenMode = !isZenMode;
    if (isZenMode) {
        document.body.classList.add('zen-mode');
        document.getElementById('exit-zen-btn').style.display = 'block';
    } else {
        document.body.classList.remove('zen-mode');
        document.getElementById('exit-zen-btn').style.display = 'none';
        
        // Re-focus the editor so the top bar animations reset properly
        document.getElementById('editor-content').focus();
    }
}

// --- KaTeX Math Rendering ---
function renderMath() {
    if (currentFormat !== 'docx') return;
    const editor = document.getElementById('editor-content');
    
    // We render math inside the content editable. 
    // auto-render extension wraps it in katex DOM elements that we can extract later.
    renderMathInElement(editor, {
        delimiters: [
            {left: '$$', right: '$$', display: true},
            {left: '$', right: '$', display: false}
        ],
        throwOnError: false,
        output: 'html' // outputs spans with class "katex" 
        // the original tex is secretly saved as MathML <annotation encoding="application/x-tex">
    });
    
    // Once rendered, we want to make the rendered katex containers un-editable 
    // so the user doesn't accidentally type inside a giant block of svg spanning math paths
    const mathNodes = editor.querySelectorAll('.katex');
    mathNodes.forEach(node => {
        node.contentEditable = "false";
        node.style.cursor = "pointer";
        node.title = "Math equation (Rendered)";
    });
    queueSave();
}

// --- Versions API Deletion ---
async function deleteVersion(versionId) {
    if(!confirm("Are you sure you want to permanently delete this version?")) return;
    try {
        const res = await fetch(`/api/documents/${docId}/versions/${versionId}`, {
            method: 'DELETE'
        });
        
        if (res.ok) {
            // Re-fetch the version list to update UI
            showVersions();
        } else {
            console.error("Failed to delete version.");
        }
    } catch (err) {
        console.error(err);
    }
}
