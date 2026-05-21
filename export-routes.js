const express = require('express');
const router = express.Router();
const db = require('./database');
const docx = require('docx');
const PDFDocument = require('pdfkit');

// Fetch doc middleware
async function fetchDoc(req, res, next) {
    db.get(`SELECT * FROM documents WHERE id = ? AND user_id = ?`, [req.params.id, req.session.userId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Document not found.' });
        req.doc = row;
        next();
    });
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
