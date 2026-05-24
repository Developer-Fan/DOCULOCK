const express = require('express');
const router = express.Router();
const db = require('./database');
const docx = require('docx');
const PDFDocument = require('pdfkit');

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

async function resolveExportAccess(documentId, userId = null, shareToken = null) {
    const document = await dbGet('SELECT * FROM documents WHERE id = ?', [documentId]);
    if (!document) return null;

    if (userId && Number(document.user_id) === Number(userId)) {
        return document;
    }

    if (userId) {
        const sharedPermission = await dbGet(
            `SELECT document_permissions.permission_level, document_permissions.source_share_link_id, share_links.id AS active_share_link_id, share_links.expires_at
             FROM document_permissions
             LEFT JOIN share_links ON share_links.id = document_permissions.source_share_link_id
             WHERE document_permissions.document_id = ? AND document_permissions.user_id = ?`,
            [documentId, userId]
        );

        if (sharedPermission) {
            const activeShareLink = sharedPermission.active_share_link_id && (!sharedPermission.expires_at || new Date(sharedPermission.expires_at) >= new Date());
            if (!sharedPermission.source_share_link_id || activeShareLink) {
                return document;
            }
        }
    }

    if (shareToken) {
        const shareLink = await dbGet(
            'SELECT * FROM share_links WHERE token = ? AND document_id = ?',
            [shareToken, documentId]
        );

        if (shareLink) {
            const expired = shareLink.expires_at && new Date(shareLink.expires_at) < new Date();
            if (!expired) {
                return document;
            }
        }
    }

    return null;
}

async function fetchDoc(req, res, next) {
    try {
        const document = await resolveExportAccess(req.params.id, req.session?.userId || null, req.query.share || null);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        req.doc = document;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Database error.' });
    }
}

// Download as PDF
router.get('/:id/pdf', fetchDoc, (req, res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${req.doc.title}.pdf"`);
    
    const doc = new PDFDocument();
    doc.pipe(res);
    doc.fontSize(20).text(req.doc.title, { align: 'center' });
    doc.moveDown();
    
    // Simple text stripping for HTML if it's rich text (a basic implementation)
    let content = req.doc.content.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/\n+/g, '\n\n').trim();
    doc.fontSize(12).text(content);
    doc.end();
});

// Download as DOCX
router.get('/:id/docx', fetchDoc, async (req, res) => {
    const { Document, Packer, Paragraph, TextRun } = docx;

    let contentStr = req.doc.content.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');
    const paragraphs = contentStr.split('\n').filter(p => p.trim() !== '').map(text => 
        new Paragraph({ children: [new TextRun(text)] })
    );

    const doc = new Document({
        sections: [{
            properties: {},
            children: [
                new Paragraph({ children: [new TextRun({ text: req.doc.title, bold: true, size: 32 })] }),
                ...paragraphs
            ]
        }]
    });

    try {
        const buffer = await Packer.toBuffer(doc);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${req.doc.title}.docx"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: 'Error generating docx' });
    }
});

// Download as TEX (LaTeX)
router.get('/:id/tex', fetchDoc, (req, res) => {
    let textContent = req.doc.content;
    if (req.doc.format === 'docx') {
        textContent = req.doc.content.replace(/<[^>]+>/g, '\n');
    }
    
    const texContent = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\title{${req.doc.title}}
\\begin{document}
\\maketitle

${textContent}

\\end{document}`;

    res.setHeader('Content-Type', 'application/x-tex');
    res.setHeader('Content-Disposition', `attachment; filename="${req.doc.title}.tex"`);
    res.send(texContent);
});

// Download as HTML
router.get('/:id/html', fetchDoc, (req, res) => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${req.doc.title}</title>
</head>
<body>
    <h1>${req.doc.title}</h1>
    ${req.doc.format === 'docx' ? req.doc.content : `<pre>${req.doc.content}</pre>`}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${req.doc.title}.html"`);
    res.send(htmlContent);
});

module.exports = router;
