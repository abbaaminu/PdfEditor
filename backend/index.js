const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { batchWatermark } = require('./services/watermark');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 🧩 Batch Watermark Route
app.post('/api/watermark/batch', async (req, res) => {
  try {
    const { filePaths, outputDir, options } = req.body;

    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
      return res.status(400).json({ success: false, error: 'No files provided.' });
    }

    if (!outputDir) {
      return res.status(400).json({ success: false, error: 'Output directory required.' });
    }

    const results = await batchWatermark(filePaths, outputDir, options);
    res.json({ success: true, count: results.length, processedFiles: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});