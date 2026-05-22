const urlParams = new URLSearchParams(window.location.search);
let docId = urlParams.get('id');
const shareToken = urlParams.get('share');
let currentFormat = 'docx';
let saveTimeout = null;
let collaborationSocket = null;
let collaborationSyncTimeout = null;
let collaborationCursorTimeout = null;
let canEditDocument = true;
let currentShareLink = '';
let currentSharePermission = 'edit';
let isDocumentOwner = false;
let canDeleteDocument = false;
let suppressRemoteSave = false;
let isLoggedIn = false;
let predictiveTextEnabled = true;
let boardCanvas = null;
let boardCtx = null;
let boardScrollContainer = null;
let boardIsInitialized = false;
let boardIsDrawing = false;
let boardRenderQueued = false;
let boardStrokeId = 0;
let boardState = {
    strokes: [],
    currentStroke: null,
    width: 3200,
    height: 3200,
    activeTool: 'pen'
};

// Whiteboard feature removed

if (!docId && !shareToken) {
    window.location.href = '/dashboard.html';
}

// Click outside menus closes them
document.addEventListener('click', function(event) {
    const exportMenu = document.getElementById('export-menu');
    if (exportMenu && !event.target.closest('.export-dropdown')) {
        exportMenu.style.display = 'none';
    }
    if (!event.target.closest('.template-dropdown')) {
        const templateMenu = document.getElementById('template-menu');
        if (templateMenu) templateMenu.style.display = 'none';
    }
    if (!event.target.closest('.editor-menu-wrap')) {
        closeEditorMenu();
    }
});

function closeEditorMenu() {
    const menu = document.getElementById('editor-menu');
    if (menu) menu.style.display = 'none';
}

function toggleEditorMenu() {
    const menu = document.getElementById('editor-menu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}

function updateDocumentActionVisibility() {
    const deleteButton = document.getElementById('delete-document-btn');
    if (deleteButton) {
        deleteButton.style.display = canDeleteDocument ? 'flex' : 'none';
    }
}

function getPlainEditorText() {
    // Whiteboard removed; only return textual content

    if (currentFormat === 'tex') {
        const latex = document.getElementById('latex-textarea').value || '';
        return latex
            .replace(/\\begin\{document\}[\s\S]*?\\maketitle/gi, '')
            .replace(/\\end\{document\}/gi, '')
            .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, ' ')
            .replace(/[{}]/g, ' ');
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = document.getElementById('editor-content').innerHTML || '';
    return wrapper.textContent || '';
}

function updateCollabStatus(message, count = null) {
    const statusEl = document.getElementById('collab-status');
    const countEl = document.getElementById('collab-count');
    if (statusEl) statusEl.innerText = message;
    if (countEl && count !== null) {
        countEl.innerText = `${count} collaborator${count === 1 ? '' : 's'}`;
    }
}

function applyEditPermissions() {
    const editorTools = document.getElementById('editor-tools');
    const editorContent = document.getElementById('editor-content');
    const latexTextarea = document.getElementById('latex-textarea');
    const whiteboardContainer = document.getElementById('whiteboard-container');
    const switchToggles = document.querySelector('.switch-toggles');

    if (!editorTools || !editorContent || !latexTextarea) return;

    const isBoard = currentFormat === 'board';
    editorContent.contentEditable = canEditDocument && currentFormat === 'docx';
    latexTextarea.readOnly = !canEditDocument || currentFormat !== 'tex';
    editorTools.style.display = canEditDocument && currentFormat === 'docx' ? 'flex' : 'none';

    if (whiteboardContainer) {
        whiteboardContainer.style.display = isBoard ? 'flex' : 'none';
    }

    if (switchToggles) {
        switchToggles.style.display = 'flex';
    }

    if (boardCanvas) {
        boardCanvas.style.pointerEvents = canEditDocument && isBoard ? 'auto' : 'none';
    }

    if (!canEditDocument) {
        document.getElementById('save-status').innerText = 'View only';
        updateCollabStatus('View only', 0);
    }
}

function normalizeBoardState(rawContent) {
    // Whiteboard removed: no board state to normalize
    return null;
}

function serializeWhiteboard() {
    return '';
}

function setBoardColor(value) {
    // no-op: whiteboard removed
}

function setBoardStrokeSize(value) {
    // no-op: whiteboard removed
}

function ensureBoardCanvas() {
    // Whiteboard removed: no canvas to initialize
}

function getBoardPoint(event) {
    return { x: 0, y: 0 };
}

function ensureBoardBounds(x, y) {
    // no-op: whiteboard removed
}

function resizeBoardCanvas() {
    // no-op: whiteboard removed
}

function requestBoardRender() {
    // no-op: whiteboard removed
}

function drawBoardStroke(stroke) {
    // no-op: whiteboard removed
}

function renderBoard() {
    // no-op: whiteboard removed
}

function undoBoardStroke() {
    // no-op: whiteboard removed
}

function clearWhiteboard() {
    // no-op: whiteboard removed
}

function resetWhiteboard(content) {
    // no-op: whiteboard removed
}

function scheduleBoardSync() {
    // no-op: whiteboard removed
}

function getCurrentDocumentPayload() {
    const title = document.getElementById('doc-title').value;
    return {
        title,
        content: getDocContent(),
        format: currentFormat
    };
}

function scheduleCollaborationSync() {
    if (!collaborationSocket || !canEditDocument || suppressRemoteSave) return;
    clearTimeout(collaborationSyncTimeout);
    collaborationSyncTimeout = setTimeout(() => {
        if (collaborationSocket?.connected) {
            collaborationSocket.emit('document:update', getCurrentDocumentPayload());
        }
    }, 450);
}

function sendCursorUpdate(isTyping = false) {
    if (!collaborationSocket || !collaborationSocket.connected) return;
    clearTimeout(collaborationCursorTimeout);
    collaborationCursorTimeout = setTimeout(() => {
        const selection = window.getSelection();
        const cursor = selection && selection.rangeCount
            ? {
                anchorOffset: selection.anchorOffset,
                focusOffset: selection.focusOffset,
                isCollapsed: selection.isCollapsed
            }
            : null;

        collaborationSocket.emit('cursor:update', {
            documentId: docId,
            cursor,
            isTyping
        });
    }, 100);
}

function formatChatTimestamp(value) {
    const date = value ? new Date(value) : new Date();
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function updateCollaboratorChatCount(count) {
    const countEl = document.getElementById('collab-chat-count');
    if (countEl) {
        countEl.innerText = String(count);
    }
}

function scrollCollaboratorChatToBottom() {
    const list = document.getElementById('collab-chat-list');
    if (list) {
        list.scrollTop = list.scrollHeight;
    }
}

function renderCollaboratorChatMessage(message) {
    const list = document.getElementById('collab-chat-list');
    if (!list || !message) return;

    const placeholder = list.querySelector('p');
    if (placeholder && !list.querySelector('.collab-chat-entry')) {
        placeholder.remove();
    }

    const entry = document.createElement('div');
    entry.className = 'collab-chat-entry';

    const bubble = document.createElement('div');
    bubble.className = 'collab-chat-bubble';
    bubble.textContent = message.message || '';
    bubble.style.borderLeft = `4px solid ${message.color || '#0071e3'}`;

    const meta = document.createElement('div');
    meta.className = 'collab-chat-meta';
    meta.textContent = `${message.username || 'Guest'} · ${formatChatTimestamp(message.createdAt)}`;

    entry.appendChild(bubble);
    entry.appendChild(meta);
    list.appendChild(entry);
    updateCollaboratorChatCount(list.querySelectorAll('.collab-chat-entry').length);
    scrollCollaboratorChatToBottom();
}

function renderCollaboratorChatHistory(messages = []) {
    const list = document.getElementById('collab-chat-list');
    if (!list) return;

    list.innerHTML = '';
    messages.forEach(renderCollaboratorChatMessage);
    if (!messages.length) {
        const empty = document.createElement('p');
        empty.style = 'color: var(--text-secondary); font-size: 13px; margin: 0;';
        empty.textContent = 'No collaborator messages yet.';
        list.appendChild(empty);
    }
    updateCollaboratorChatCount(messages.length);
}

function toggleCollaboratorChat(forceOpen = null) {
    const drawer = document.getElementById('collab-chat-drawer');
    if (!drawer) return;

    const shouldOpen = forceOpen === null ? !drawer.classList.contains('open') : Boolean(forceOpen);
    drawer.classList.toggle('open', shouldOpen);
    drawer.setAttribute('aria-hidden', String(!shouldOpen));

    if (shouldOpen) {
        scrollCollaboratorChatToBottom();
        const input = document.getElementById('collab-chat-input');
        if (input) {
            setTimeout(() => input.focus(), 0);
        }
    }
}

async function sendCollaboratorChat() {
    if (!collaborationSocket || !docId) return;

    const input = document.getElementById('collab-chat-input');
    const message = input?.value.trim();
    if (!message) return;

    collaborationSocket.emit('collab:chat:send', {
        documentId: docId,
        message
    });

    if (input) {
        input.value = '';
        input.focus();
    }
}

function syncCollaboratorList(collaborators = []) {
    updateCollabStatus('Connected', collaborators.length);
    const names = collaborators
        .map(person => person.username)
        .filter(Boolean)
        .slice(0, 3);

    const statusEl = document.getElementById('collab-status');
    if (statusEl) {
        statusEl.innerText = names.length
            ? `Connected · ${names.join(', ')}${collaborators.length > names.length ? '…' : ''}`
            : 'Connected';
    }
}

function removeGhostPrediction() {
    const ghostSpan = document.getElementById('ghost-text-span');
    if (ghostSpan) ghostSpan.remove();
    currentGhostPrediction = '';
}

async function loadDashboardPreferences() {
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;

        const data = await res.json();
        predictiveTextEnabled = data.predictiveText !== false;
        isDarkMode = Boolean(data.darkMode);
        applyDarkMode();
    } catch (err) {
        isDarkMode = localStorage.getItem('darkMode') === 'true';
        applyDarkMode();
    }
}

function connectCollaboration() {
    if (!docId || typeof io === 'undefined') return;

    if (collaborationSocket) {
        collaborationSocket.disconnect();
    }

    collaborationSocket = io({
        auth: {
            shareToken
        }
    });

    collaborationSocket.on('connect', () => {
        updateCollabStatus('Connecting...', 0);
        collaborationSocket.emit('collab:join', {
            documentId: docId,
            shareToken
        });
    });

    collaborationSocket.on('collab:sync', (payload) => {
        if (!payload || Number(payload.documentId) !== Number(docId)) return;

        canEditDocument = Boolean(payload.canEdit);
        currentSharePermission = payload.permissionLevel || 'edit';
        syncCollaboratorList(payload.collaborators || []);

        removeGhostPrediction();
        suppressRemoteSave = true;
        document.getElementById('doc-title').value = payload.title || 'Untitled';
        currentFormat = payload.format || 'docx';
        switchFormat(currentFormat, false);

        if (currentFormat === 'tex') {
            document.getElementById('latex-textarea').value = payload.content || '';
        } else if (currentFormat === 'board') {
            resetWhiteboard(payload.content);
        } else {
            document.getElementById('editor-content').innerHTML = payload.content || '';
        }
        suppressRemoteSave = false;

        applyEditPermissions();
    });

    collaborationSocket.on('collab:presence', (payload) => {
        if (!payload || Number(payload.documentId) !== Number(docId)) return;
        syncCollaboratorList(payload.collaborators || []);
    });

    collaborationSocket.on('document:update', (payload) => {
        if (!payload || Number(payload.documentId) !== Number(docId)) return;
        if (payload.sourceSocketId === collaborationSocket.id) return;

        removeGhostPrediction();
        suppressRemoteSave = true;
        document.getElementById('doc-title').value = payload.title || document.getElementById('doc-title').value;
        currentFormat = payload.format || currentFormat;
        switchFormat(currentFormat, false);

        if (currentFormat === 'tex') {
            document.getElementById('latex-textarea').value = payload.content || '';
        } else if (currentFormat === 'board') {
            resetWhiteboard(payload.content);
        } else {
            document.getElementById('editor-content').innerHTML = payload.content || '';
        }
        suppressRemoteSave = false;

        document.getElementById('save-status').innerText = `Updated by ${payload.updatedBy || 'collaborator'}`;
        setTimeout(() => {
            if (document.getElementById('save-status').innerText.startsWith('Updated by')) {
                document.getElementById('save-status').innerText = '';
            }
        }, 2500);
    });

    collaborationSocket.on('cursor:update', (payload) => {
        if (!payload || Number(payload.documentId) !== Number(docId)) return;
        const statusEl = document.getElementById('collab-status');
        if (statusEl && payload.username) {
            statusEl.innerText = `${payload.username} ${payload.isTyping ? 'is typing' : 'is here'}`;
        }
    });

    collaborationSocket.on('collab:error', (payload) => {
        updateCollabStatus(payload?.message || 'Collaboration unavailable', 0);
    });

    collaborationSocket.on('collab:chat:history', (payload) => {
        if (!payload || Number(payload.documentId) !== Number(docId)) return;
        renderCollaboratorChatHistory(payload.messages || []);
    });

    collaborationSocket.on('collab:chat:message', (message) => {
        if (!message || Number(message.documentId) !== Number(docId)) return;
        renderCollaboratorChatMessage(message);
    });

    collaborationSocket.on('document:deleted', (payload) => {
        if (!payload || Number(payload.documentId) !== Number(docId)) return;
        alert('This document was deleted by its owner.');
        window.location.href = '/dashboard.html';
    });

    collaborationSocket.on('disconnect', () => {
        updateCollabStatus('Offline', 0);
    });
}

fetch('/api/me')
    .then(res => {
        if (!res.ok) throw new Error('not authenticated');
        return res.json();
    })
    .then(() => {
        isLoggedIn = true;
        loadDashboardPreferences();
    })
    .catch(() => {
        isLoggedIn = false;
        loadDashboardPreferences();
    });

async function loadDoc() {
    try {
        const endpoint = shareToken ? `/api/share/${shareToken}` : `/api/docs/${docId}`;
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error('Not found');
        const doc = await res.json();

        const loadedDoc = doc.document || doc;
        if (!docId && loadedDoc.id) {
            docId = loadedDoc.id;
        }

        isDocumentOwner = doc.accessType ? doc.accessType === 'owner' : !shareToken;
        canDeleteDocument = isDocumentOwner && !shareToken;

        document.getElementById('doc-title').value = loadedDoc.title;
        currentFormat = loadedDoc.format || 'docx';
        switchFormat(currentFormat, false);
        if (currentFormat === 'board') {
            resetWhiteboard(loadedDoc.content);
        }

        canEditDocument = typeof doc.canEdit === 'boolean' ? Boolean(doc.canEdit) : true;
        currentSharePermission = doc.permissionLevel || (isDocumentOwner ? 'owner' : 'edit');
        currentShareLink = shareToken ? `${window.location.origin}/editor.html?share=${shareToken}` : '';

        if (currentFormat === 'tex') {
            document.getElementById('latex-textarea').value = loadedDoc.content || '';
        } else if (currentFormat !== 'board') {
            document.getElementById('editor-content').innerHTML = loadedDoc.content || '';
        }

        applyEditPermissions();
        updateDocumentActionVisibility();
        connectCollaboration();
    } catch(err) {
        window.location.href = '/dashboard.html';
    }
}

function execCmd(command, value = null) {
    if (!canEditDocument) return;
    document.execCommand(command, false, value);
    document.getElementById('editor-content').focus();
    queueSave();
    scheduleCollaborationSync();
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
    // Only support 'docx' and 'tex'
    if (format !== 'tex') format = 'docx';
    currentFormat = format;
    document.getElementById('btn-docx').classList.toggle('active', format === 'docx');
    document.getElementById('btn-tex').classList.toggle('active', format === 'tex');
    removeGhostPrediction();

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

    applyEditPermissions();
    updateDocumentStats();
}

function getDocContent() {
    if (currentFormat === 'board') {
        return serializeWhiteboard();
    }

    if (currentFormat === 'tex') {
        updateDocumentStats();
        return document.getElementById('latex-textarea').value;
    }
    return document.getElementById('editor-content').innerHTML;
}

function queueSave() {
    if (!canEditDocument || suppressRemoteSave) return;
    document.getElementById('save-status').innerText = 'Unsaved changes...';
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveDoc, 1000);
    scheduleCollaborationSync();
}

async function saveDoc() {
    if (!canEditDocument) return;
    const title = document.getElementById('doc-title').value;
    const content = getDocContent();
    document.getElementById('save-status').innerText = 'Saving...';

    const endpoint = shareToken ? `/api/share/${shareToken}` : `/api/docs/${docId}`;
    await fetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, format: currentFormat })
    });

    document.getElementById('save-status').innerText = 'All changes saved.';
    setTimeout(() => { if (document.getElementById('save-status').innerText === 'All changes saved.') document.getElementById('save-status').innerText = ''; }, 3000);
}

async function deleteDoc() {
    if (!canDeleteDocument) return;
    if (!confirm('Are you sure you want to permanently delete this document? This cannot be undone.')) return;

    const res = await fetch(`/api/docs/${docId}`, { method: 'DELETE' });
    if (!res.ok) {
        let message = 'Unable to delete this document.';
        try {
            const data = await res.json();
            if (data?.error) message = data.error;
        } catch (err) {
            // Ignore JSON parsing issues and keep the default message.
        }
        alert(message);
        return;
    }

    window.location.href = '/dashboard.html';
}

function exportDoc(type) {
    document.getElementById('export-menu').style.display = 'none';
    window.open(`/api/export/${docId}/${type}`, '_blank');
}

function applyAIEdit(newContent) {
    if (!canEditDocument) return;
    if (currentFormat === 'tex') {
        document.getElementById('latex-textarea').value = newContent;
    } else {
        document.getElementById('editor-content').innerHTML = newContent;
    }
    queueSave();
    scheduleCollaborationSync();
}

// AI Integration
async function sendAI() {
    if (!isLoggedIn) {
        const chatBox = document.getElementById('chat-box');
        const warning = document.createElement('div');
        warning.className = 'chat-msg chat-ai';
        warning.innerText = 'AI assistance requires an authenticated session.';
        chatBox.appendChild(warning);
        return;
    }
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
    const currentTone = sessionStorage.getItem('currentTone') || null;

    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, documentContent: content, tone: currentTone })
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

        // Clear tone after use
        sessionStorage.removeItem('currentTone');

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
        removeGhostPrediction();
    }
});

editorContentElement.addEventListener('input', (e) => {
    clearTimeout(autocompleteTimeout);
    removeGhostPrediction();

    // Only fetch if we are in DOCX visual mode and have text
    if (currentFormat !== 'docx' || !predictiveTextEnabled || !canEditDocument) return;

    const text = editorContentElement.innerText.trim();
    if (text.length > 5) {
        // Wait 1.2 seconds of no typing before showing auto-complete
        autocompleteTimeout = setTimeout(fetchAutocomplete, 1200);
    }

    scheduleCollaborationSync();
    sendCursorUpdate(true);
});

document.getElementById('latex-textarea').addEventListener('input', () => {
    scheduleCollaborationSync();
    sendCursorUpdate(true);
});

document.getElementById('doc-title').addEventListener('input', () => {
    scheduleCollaborationSync();
});

async function fetchAutocomplete() {
    // Grab text from the editor to send to AI
    const contextText = editorContentElement.innerText.slice(-300); // Last 300 chars
    if (!contextText.trim()) return;
    if (!predictiveTextEnabled || !canEditDocument) return;

    try {
        const res = await fetch('/api/ai/autocomplete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contextText, documentId: docId, shareToken })
        });
        const data = await res.json();

        if (data.prediction && data.prediction.trim().length > 0) {
            let ghostSpan = document.getElementById('ghost-text-span');
            if (ghostSpan) removeGhostPrediction();

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
    if (!isLoggedIn) {
        alert('Version history requires an authenticated session.');
        return;
    }
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
    if (!isLoggedIn) {
        alert('Citations require an authenticated session.');
        return;
    }
    document.getElementById('cite-modal').style.display = 'block';
    document.getElementById('cite-result').style.display = 'none';
    document.getElementById('cite-result').value = '';
    document.getElementById('cite-insert-btn').style.display = 'none';
    document.getElementById('cite-input').value = '';
}

async function fetchCitation() {
    if (!isLoggedIn) {
        document.getElementById('cite-result').style.display = 'block';
        document.getElementById('cite-result').value = 'Citations require an authenticated session.';
        return;
    }
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

function showShare() {
    document.getElementById('share-modal').style.display = 'block';
    const output = document.getElementById('share-link-output');
    output.value = currentShareLink || (shareToken ? `${window.location.origin}/editor.html?share=${shareToken}` : '');
    refreshShareLinks();
}

function closeShare() {
    document.getElementById('share-modal').style.display = 'none';
}

function copyShareLink() {
    const output = document.getElementById('share-link-output');
    if (!output.value) return;
    navigator.clipboard.writeText(output.value);
}

async function createShareLink() {
    if (!isLoggedIn) {
        alert('Only authenticated owners can create share links.');
        return;
    }

    const permissionLevel = document.getElementById('share-permission').value;
    const res = await fetch(`/api/docs/${docId}/share-links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionLevel })
    });

    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Unable to create share link.');
        return;
    }

    currentShareLink = data.url;
    document.getElementById('share-link-output').value = data.url;
    refreshShareLinks();
}

async function inviteCollaboratorByUsername() {
    if (!isLoggedIn) {
        alert('Only authenticated owners can invite collaborators.');
        return;
    }

    const username = document.getElementById('invite-username').value.trim();
    const permissionLevel = document.getElementById('invite-permission').value;

    if (!username) {
        alert('Enter a username to invite.');
        return;
    }

    const res = await fetch(`/api/docs/${docId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, permissionLevel })
    });

    const data = await res.json();
    if (!res.ok) {
        alert(data.error || 'Unable to invite collaborator.');
        return;
    }

    document.getElementById('invite-username').value = '';
    alert(`Invited ${data.username} with ${data.permissionLevel} access.`);
}

async function refreshShareLinks() {
    const list = document.getElementById('share-links-list');
    if (!isLoggedIn) {
        list.innerHTML = '<p style="color: var(--text-secondary); font-size: 13px;">Share link creation requires an authenticated owner session.</p>';
        return;
    }

    list.innerHTML = '<p style="color: var(--text-secondary); font-size: 13px;">Loading share links...</p>';
    try {
        const res = await fetch(`/api/docs/${docId}/share-info`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load share links');

        const links = data.links || [];
        const collaborators = data.collaborators || [];
        list.innerHTML = '';

        const collaboratorsSection = document.createElement('div');
        collaboratorsSection.style = 'display: grid; gap: 8px;';

        const collaboratorsTitle = document.createElement('div');
        collaboratorsTitle.innerHTML = '<strong>Collaborators</strong>';
        collaboratorsSection.appendChild(collaboratorsTitle);

        if (!collaborators.length) {
            const emptyCollaborators = document.createElement('p');
            emptyCollaborators.style = 'color: var(--text-secondary); font-size: 13px; margin: 0;';
            emptyCollaborators.textContent = 'No collaborators invited yet.';
            collaboratorsSection.appendChild(emptyCollaborators);
        } else {
            collaborators.forEach(person => {
                const row = document.createElement('div');
                row.style = 'padding: 12px; border: 1px solid var(--border); border-radius: 10px; display: grid; gap: 6px; background: rgba(0,0,0,0.02);';

                const top = document.createElement('div');
                top.style = 'display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap;';
                top.innerHTML = `<strong>${person.username}</strong><span style="font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em;">${person.permission_level}</span>`;

                const source = document.createElement('div');
                source.style = 'font-size: 12px; color: var(--text-secondary);';
                source.textContent = person.share_token
                    ? `Invited via share link ${person.share_token.slice(0, 8)}${person.share_expires_at && new Date(person.share_expires_at) < new Date() ? ' · expired' : ''}`
                    : 'Invited directly by username';

                row.appendChild(top);
                row.appendChild(source);
                collaboratorsSection.appendChild(row);
            });
        }

        list.appendChild(collaboratorsSection);

        const linksSection = document.createElement('div');
        linksSection.style = 'display: grid; gap: 8px; margin-top: 16px;';

        const linksTitle = document.createElement('div');
        linksTitle.innerHTML = '<strong>Share links</strong>';
        linksSection.appendChild(linksTitle);

        if (!links.length) {
            const emptyLinks = document.createElement('p');
            emptyLinks.style = 'color: var(--text-secondary); font-size: 13px; margin: 0;';
            emptyLinks.textContent = 'No share links yet.';
            linksSection.appendChild(emptyLinks);
            list.appendChild(linksSection);
            return;
        }

        links.forEach(link => {
            const row = document.createElement('div');
            row.style = 'padding: 12px; border: 1px solid var(--border); border-radius: 10px; display: grid; gap: 8px; background: rgba(0,0,0,0.02);';

            const meta = document.createElement('div');
            meta.innerHTML = `<strong>${link.permission_level}</strong> · ${link.token.slice(0, 8)}… · ${link.access_count || 0} opens`;

            const linkInput = document.createElement('input');
            linkInput.type = 'text';
            linkInput.readOnly = true;
            linkInput.value = `${window.location.origin}/editor.html?share=${link.token}`;
            linkInput.style = 'width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;';

            const actions = document.createElement('div');
            actions.style = 'display: flex; gap: 8px; flex-wrap: wrap;';

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn secondary';
            copyBtn.textContent = 'Copy';
            copyBtn.onclick = () => navigator.clipboard.writeText(linkInput.value);

            const revokeBtn = document.createElement('button');
            revokeBtn.className = 'btn secondary';
            revokeBtn.style.color = '#ff3b30';
            revokeBtn.textContent = 'Revoke';
            revokeBtn.onclick = async () => {
                await fetch(`/api/share-links/${link.id}`, { method: 'DELETE' });
                refreshShareLinks();
            };

            actions.appendChild(copyBtn);
            actions.appendChild(revokeBtn);

            row.appendChild(meta);
            row.appendChild(linkInput);
            row.appendChild(actions);
            linksSection.appendChild(row);
        });

        list.appendChild(linksSection);
    } catch (err) {
        list.innerHTML = '<p style="color: #ff3b30; font-size: 13px;">Error loading share links.</p>';
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
let lastSaveTime = 0;
const originalSaveDoc = saveDoc;
saveDoc = async function() {
    await originalSaveDoc();

    // Update save status
    const saveStatus = document.getElementById('save-status');
    if (saveStatus) {
        saveStatus.innerText = 'All changes saved.';
        saveStatus.style.color = '#34c759';
        setTimeout(() => {
            if (saveStatus.innerText === 'All changes saved.') {
                saveStatus.innerText = '';
            }
        }, 3000);
    }

    lastSaveTime = Date.now();

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
    // Store the tone preference for the AI to use
    sessionStorage.setItem('currentTone', tone);

    // Set up the tone instruction
    const aiInput = document.getElementById('ai-input');
    const toneDescriptions = {
        'Academic': 'Revise this document to be more academic, formal, and well-structured.',
        'Creative': 'Make this more creative and engaging with vivid, descriptive language.',
        'Concise': 'Revise this to be brief and direct, removing unnecessary elaboration.',
        'Expand': 'Expand this with more detail, examples, and comprehensive explanations.'
    };

    aiInput.value = toneDescriptions[tone] || `Apply ${tone} tone to the document.`;

    // Visually highlight the selected preset
    document.querySelectorAll('.ai-preset-chip').forEach(chip => {
        chip.style.opacity = '0.6';
        chip.style.fontWeight = 'normal';
    });
    event.target.style.opacity = '1';
    event.target.style.fontWeight = 'bold';

    // Send the AI request
    setTimeout(sendAI, 50);
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
let mathRenderTimeout = null;

function renderMath() {
    if (currentFormat !== 'docx') return;
    const editor = document.getElementById('editor-content');

    try {
        renderMathInElement(editor, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false}
            ],
            throwOnError: false,
            output: 'html'
        });

        // Make rendered math nodes un-editable
        const mathNodes = editor.querySelectorAll('.katex');
        mathNodes.forEach(node => {
            node.contentEditable = "false";
            node.style.cursor = "pointer";
            node.title = "Math equation (Rendered)";
        });
    } catch(err) {
        console.error('KaTeX render error:', err);
    }
    queueSave();
}

// Auto-render math on input with debounce
document.getElementById('editor-content').addEventListener('input', () => {
    clearTimeout(mathRenderTimeout);
    if (currentFormat === 'docx') {
        mathRenderTimeout = setTimeout(renderMath, 500);
    }
});

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

// --- Settings Modal Version Management ---
async function refreshVersionsList() {
    const list = document.getElementById('settings-versions-list');
    list.innerHTML = 'Loading versions...';
    try {
        const res = await fetch(`/api/documents/${docId}/versions`);
        const versions = await res.json();
        list.innerHTML = '';

        if (versions.length === 0) {
            list.innerHTML = '<p style="font-size: 13px; color: var(--text-secondary);">No versions yet. Versions are auto-saved as you edit.</p>';
            return;
        }

        versions.forEach(v => {
            const div = document.createElement('div');
            div.style = 'padding: 8px 0; font-size: 13px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,0,0,0.05);';

            const dateSpan = document.createElement('span');
            dateSpan.innerText = new Date(v.created_at).toLocaleString();
            dateSpan.style = 'flex: 1;';

            const delBtn = document.createElement('button');
            delBtn.className = 'btn secondary';
            delBtn.style = 'padding: 4px 8px; font-size: 12px; color: #ff3b30;';
            delBtn.innerText = '×';
            delBtn.onclick = () => deleteVersion(v.id);

            div.appendChild(dateSpan);
            div.appendChild(delBtn);
            list.appendChild(div);
        });
    } catch(err) {
        list.innerHTML = '<p style="color: red; font-size: 13px;">Error loading versions.</p>';
    }
}

async function deleteAllOldVersions() {
    if (!confirm('Delete all versions except the current document? This cannot be undone.')) return;

    try {
        const res = await fetch(`/api/documents/${docId}/versions`);
        const versions = await res.json();

        let deleted = 0;
        for (let v of versions) {
            await fetch(`/api/documents/${docId}/versions/${v.id}`, { method: 'DELETE' });
            deleted++;
        }

        alert(`Successfully deleted ${deleted} versions.`);
        refreshVersionsList();
    } catch (err) {
        alert('Error deleting versions.');
    }
}

// ============================================
// PHASE 1: QUICK WINS
// ============================================

// --- Dark Mode ---
let isDarkMode = localStorage.getItem('darkMode') === 'true';

function applyDarkMode() {
    document.body.classList.toggle('dark-mode', isDarkMode);
}

// Apply dark mode on load
applyDarkMode();

// --- Word Count & Reading Time ---
let statsTimeout = null;

function updateDocumentStats() {
    clearTimeout(statsTimeout);
    statsTimeout = setTimeout(() => {
        const content = getPlainEditorText().replace(/\u00a0/g, ' ').trim();
        const words = content ? content.split(/\s+/).filter(Boolean).length : 0;
        const chars = content.length;
        const readingTime = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));

        document.getElementById('doc-stats').innerText = `${words} words`;
        document.getElementById('reading-time').innerText = words === 0 ? '0 min read' : `~${readingTime} min read`;
    }, 300);
}

document.getElementById('editor-content').addEventListener('input', updateDocumentStats);
document.getElementById('latex-textarea').addEventListener('input', updateDocumentStats);

// --- Keyboard Shortcuts ---
document.addEventListener('keydown', (e) => {
    // Ctrl+S / Cmd+S - Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveDoc();
    }
    // Ctrl+F / Cmd+F - Find & Replace
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        document.getElementById('find-replace-modal').style.display = 'flex';
        document.getElementById('find-input').focus();
    }
    // Ctrl+Shift+Z / Cmd+Shift+Z - Zen Mode
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        toggleZen();
    }
    // Escape - Close modals
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    }
});

// --- Find & Replace ---
let currentFindIndex = -1;
let findMatches = [];

function findNext() {
    const searchTerm = document.getElementById('find-input').value;
    if (!searchTerm) return;

    const content = currentFormat === 'tex'
        ? document.getElementById('latex-textarea').value
        : document.getElementById('editor-content').innerText;

    const regex = new RegExp(searchTerm, 'gi');
    findMatches = [...content.matchAll(regex)];

    if (findMatches.length > 0) {
        currentFindIndex = (currentFindIndex + 1) % findMatches.length;
        const match = findMatches[currentFindIndex];
        document.getElementById('find-results').innerText =
            `Match ${currentFindIndex + 1} of ${findMatches.length}`;
        highlightMatch(match);
    } else {
        document.getElementById('find-results').innerText = 'No matches found';
    }
}

function replaceCurrent() {
    if (currentFindIndex === -1) return findNext();

    const searchTerm = document.getElementById('find-input').value;
    const replaceTerm = document.getElementById('replace-input').value;

    if (currentFormat === 'tex') {
        const textarea = document.getElementById('latex-textarea');
        textarea.value = textarea.value.replace(new RegExp(searchTerm, 'i'), replaceTerm);
    } else {
        const editor = document.getElementById('editor-content');
        editor.innerText = editor.innerText.replace(new RegExp(searchTerm, 'i'), replaceTerm);
    }

    findNext();
    queueSave();
}

function replaceAll() {
    const searchTerm = document.getElementById('find-input').value;
    const replaceTerm = document.getElementById('replace-input').value;

    if (currentFormat === 'tex') {
        const textarea = document.getElementById('latex-textarea');
        const newText = textarea.value.replaceAll(searchTerm, replaceTerm);
        const count = (textarea.value.match(new RegExp(searchTerm, 'g')) || []).length;
        textarea.value = newText;
        alert(`Replaced ${count} occurrences.`);
    } else {
        const editor = document.getElementById('editor-content');
        const newHTML = editor.innerHTML.replaceAll(searchTerm, replaceTerm);
        const count = (editor.innerHTML.match(new RegExp(searchTerm, 'g')) || []).length;
        editor.innerHTML = newHTML;
        alert(`Replaced ${count} occurrences.`);
    }

    currentFindIndex = -1;
    findMatches = [];
    document.getElementById('find-results').innerText = '';
    queueSave();
}

function highlightMatch(match) {
    if (currentFormat === 'docx') {
        const editor = document.getElementById('editor-content');
        const sel = window.getSelection();
        const range = document.createRange();
        // Simple highlight - just show the match
        document.getElementById('find-results').innerText = `Matched: "${match[0]}"`;
    }
}

// --- Outline / Table of Contents ---
function buildOutline() {
    if (currentFormat !== 'docx') return;

    const editor = document.getElementById('editor-content');
    const headings = editor.querySelectorAll('h1, h2, h3');
    const outlineList = document.getElementById('outline-list');
    outlineList.innerHTML = '';

    headings.forEach((heading, index) => {
        const level = parseInt(heading.tagName[1]);
        const item = document.createElement('div');
        item.style = `padding-left: ${(level - 1) * 20}px; padding: 8px; cursor: pointer; border-radius: 4px;`;
        item.className = 'outline-item';
        item.innerText = heading.innerText;
        item.onclick = () => heading.scrollIntoView({ behavior: 'smooth' });
        item.onmouseover = () => item.style.backgroundColor = 'rgba(0,113,227,0.1)';
        item.onmouseout = () => item.style.backgroundColor = 'transparent';

        outlineList.appendChild(item);
    });
}

function toggleOutline() {
    const pane = document.getElementById('outline-pane');
    const isVisible = pane.style.display === 'block';
    pane.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) buildOutline();
}

document.getElementById('editor-content').addEventListener('input', () => {
    if (document.getElementById('outline-pane').style.display === 'block') {
        buildOutline();
    }
});

// --- Accessibility ---
function updateFontSize(value) {
    const percent = parseInt(value);
    document.getElementById('editor-content').style.fontSize = (16 * percent / 100) + 'px';
    document.getElementById('latex-textarea').style.fontSize = (14 * percent / 100) + 'px';
    document.getElementById('font-size-value').innerText = value + '%';
    localStorage.setItem('fontSize', value);
}

function updateLineHeight(value) {
    const height = parseFloat(value);
    document.getElementById('editor-content').style.lineHeight = height;
    document.getElementById('latex-textarea').style.lineHeight = height;
    document.getElementById('line-height-value').innerText = value;
    localStorage.setItem('lineHeight', value);
}

function toggleHighContrast() {
    const isEnabled = document.getElementById('high-contrast-toggle').checked;
    if (isEnabled) {
        document.body.classList.add('high-contrast');
        document.body.classList.remove('dark-mode');
    } else {
        document.body.classList.remove('high-contrast');
        applyDarkMode();
    }
    localStorage.setItem('highContrast', isEnabled);
}

function resetAccessibility() {
    document.getElementById('font-size-slider').value = '100';
    document.getElementById('line-height-slider').value = '1.5';
    document.getElementById('high-contrast-toggle').checked = false;

    updateFontSize('100');
    updateLineHeight('1.5');
    toggleHighContrast();
}

function showAccessibility() {
    document.getElementById('accessibility-modal').style.display = 'flex';

    // Load saved values
    const fontSize = localStorage.getItem('fontSize') || '100';
    const lineHeight = localStorage.getItem('lineHeight') || '1.5';
    const highContrast = localStorage.getItem('highContrast') === 'true';

    document.getElementById('font-size-slider').value = fontSize;
    document.getElementById('line-height-slider').value = lineHeight;
    document.getElementById('high-contrast-toggle').checked = highContrast;

    document.getElementById('font-size-value').innerText = fontSize + '%';
    document.getElementById('line-height-value').innerText = lineHeight;
}

// Apply accessibility on load
const savedFontSize = localStorage.getItem('fontSize');
const savedLineHeight = localStorage.getItem('lineHeight');
if (savedFontSize) updateFontSize(savedFontSize);
if (savedLineHeight) updateLineHeight(savedLineHeight);

// --- Keyboard Shortcuts Display ---
function showKeyboardShortcuts() {
    document.getElementById('shortcuts-modal').style.display = 'flex';
}

// ============================================
// PHASE 2: ADVANCED FEATURES
// ============================================

// --- Custom AI Personas ---
const aiPersonas = {
    'Editor': 'You are a professional editor. Focus on grammar, clarity, structure, and flow. Provide detailed feedback on how to improve the writing.',
    'Brainstormer': 'You are a creative brainstorming partner. Generate new ideas, expand on concepts, suggest examples, and help the user think deeper about their topic.',
    'Critic': 'You are a constructive critic. Analyze the writing for logical consistency, arguments, evidence, and provide thoughtful critique without being harsh.',
    'Summarizer': 'You are a summarization expert. Distill the key points into a concise summary that captures the essence of the content.',
    'Llama': 'You are Llama 3, a highly intelligent AI assistant integrated into a document editor called DocuLock.'
};

let currentPersona = 'Llama';

function setAIPersona(persona) {
    currentPersona = persona;
    const presets = document.querySelectorAll('.ai-presets:first-of-type .ai-preset-chip');
    presets.forEach(btn => {
        if (btn.innerText.includes(persona)) {
            btn.style.fontWeight = 'bold';
            btn.style.opacity = '1';
        } else {
            btn.style.fontWeight = 'normal';
            btn.style.opacity = '0.6';
        }
    });
    sessionStorage.setItem('currentPersona', persona);
}

// --- Enhanced AI Chat with Personas ---
const originalSendAI = sendAI;
sendAI = async function() {
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
    const currentTone = sessionStorage.getItem('currentTone') || null;
    const persona = sessionStorage.getItem('currentPersona') || 'Llama';

    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, documentContent: content, tone: currentTone, persona })
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

        // Clear tone after use
        sessionStorage.removeItem('currentTone');

    } catch(err) {
        aiDiv.innerText = "Connection error.";
    }
    chatBox.scrollTop = chatBox.scrollHeight;
};

// --- Document Templates ---
const docTemplates = {
    'Research Paper': `# Research Paper Template

## Abstract
[Provide a brief summary of your research, objectives, and findings]

## Introduction
[Introduce the topic and research question]

## Literature Review
[Review existing research and theories]

## Methodology
[Describe your research approach]

## Results
[Present your findings]

## Discussion
[Interpret your results]

## Conclusion
[Summarize and suggest future research]

## References
[List your sources]`,

    'Essay': `# Essay

## Introduction
[Hook the reader and introduce your thesis]

## Body Paragraph 1
[Support your thesis with evidence]

## Body Paragraph 2
[Continue supporting with more points]

## Body Paragraph 3
[Add additional supporting evidence]

## Conclusion
[Restate thesis and provide closure]`,

    'Meeting Notes': `# Meeting Notes

**Date:** [Date]
**Attendees:** [Names]
**Agenda:** [Main topics]

## Discussion Points
- Point 1
- Point 2
- Point 3

## Action Items
- [ ] Action item 1 - Assigned to: [Name]
- [ ] Action item 2 - Assigned to: [Name]

## Next Steps
[Summary of what's next]`,

    'Letter': `[Your Name]
[Your Address]
[Date]

[Recipient Name]
[Recipient Address]

Dear [Recipient Name],

[Opening paragraph - State the purpose]

[Body paragraph(s) - Provide details and context]

[Closing paragraph - Call to action and professional closing]

Sincerely,

[Your Name]`
};

function applyTemplate(templateName) {
    if (!docTemplates[templateName]) return;

    const confirmed = confirm(`Apply "${templateName}" template? This will replace current content.`);
    if (!confirmed) return;

    const templateContent = docTemplates[templateName];

    if (currentFormat === 'tex') {
        document.getElementById('latex-textarea').value = templateContent;
    } else {
        document.getElementById('editor-content').innerHTML = templateContent.split('\n').map(line => {
            if (line.startsWith('# ')) return `<h1>${line.substring(2)}</h1>`;
            if (line.startsWith('## ')) return `<h2>${line.substring(3)}</h2>`;
            if (line.startsWith('- ')) return `<li>${line.substring(2)}</li>`;
            return `<p>${line}</p>`;
        }).join('');
    }

    queueSave();
    updateDocumentStats();
}

// --- Grammar & Style Checking ---
async function checkGrammar() {
    const content = getDocContent();
    const minLength = 100;

    if (content.length < minLength) {
        alert('Please write more content before checking grammar (minimum 100 characters).');
        return;
    }

    const chatBox = document.getElementById('chat-box');
    const analysisDiv = document.createElement('div');
    analysisDiv.className = 'chat-msg chat-ai';
    analysisDiv.innerText = 'Analyzing grammar and style...';
    chatBox.appendChild(analysisDiv);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Please analyze this text for grammar, style, and clarity. Suggest improvements.',
                documentContent: content
            })
        });
        const data = await res.json();
        analysisDiv.innerText = data.reply || 'Analysis complete.';
    } catch(err) {
        analysisDiv.innerText = 'Error analyzing text.';
    }
}

// --- Text-to-Speech ---
function speakContent() {
    const content = currentFormat === 'tex'
        ? document.getElementById('latex-textarea').value
        : document.getElementById('editor-content').innerText;

    if (!('speechSynthesis' in window)) {
        alert('Text-to-Speech not supported in your browser.');
        return;
    }

    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        return;
    }

    const utterance = new SpeechSynthesisUtterance(content);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.volume = 1;

    window.speechSynthesis.speak(utterance);
}

const autoCheckpointInterval = 300000; // 5 minutes

function createCheckpoint() {
    fetch(`/api/documents/${docId}/versions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ content: getDocContent() })
    });
}

// Auto-checkpoint every 5 minutes
setInterval(() => {
    if (document.getElementById('save-status').innerText === '') {
        createCheckpoint();
    }
}, autoCheckpointInterval);

// Enhanced save status
const originalQueueSave = queueSave;
queueSave = function() {
    document.getElementById('save-status').innerText = 'Unsaved changes...';
    document.getElementById('save-status').style.color = '#ff9500';
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveDoc, 1000);
};

// Diff Viewer for Versions
function showVersionDiff(versionId) {
    alert('Diff viewer coming soon! This will show side-by-side comparison of versions.');
}
