const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');

const app = express();
const PORT = 3000;

// Configuración de multer para subir el archivo Excel
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.use(cors());
app.use(express.static('public'));

// Ruta principal que recibe el Excel y hace el scraping
app.post('/importar-excel', upload.single('file'), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).send('No se subió ningún archivo.');
  }

  console.log("Archivo recibido:", file.originalname);

  // Leer el archivo Excel
  const workbook = xlsx.read(file.buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const dataExcel = xlsx.utils.sheet_to_json(sheet);
  const idFabricantes = dataExcel.map(row => row.ID_FRABRICANTE).filter(id => id);

  console.log("ID_FABRICANTE extraídos:", idFabricantes);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const resultados = [];

  try {
    for (const query of idFabricantes) {
      console.log(`Buscando: ${query}`);
      await page.goto(`https://www.fravega.com/l/?keyword=${query}`, { waitUntil: 'domcontentloaded' });

      // Intentar escribir código postal
      try {
        await page.waitForSelector('#header-geo-location-form-postal-number', { timeout: 8000 });
        await page.fill('#header-geo-location-form-postal-number', '4000');
        await page.click('button.sc-fUBkdm.hzOXoT.sc-fYKINB.itCihk');
        await page.waitForTimeout(3000); // Esperar recarga
      } catch (err) {
        console.log("No fue necesario ingresar código postal o ya estaba ingresado.");
      }

      try {
        await page.waitForSelector('a.sc-4007e61d-0.dcODtv', { timeout: 8000 });

        const href = await page.$eval('a.sc-4007e61d-0.dcODtv', a => a.href);

        const productPage = await browser.newPage();
        await productPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const producto = await productPage.evaluate(() => {
          const getText = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : null;
          };

          const getSrc = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.src : null;
          };

          return {
            pvpantes: getText('span.sc-66d25270-0.sc-2628e4d4-4.eiLwiO.kGdyWX'),
            porcentajedescuento: getText('span.sc-1d9b1d9e-0.sc-2628e4d4-3.OZgQ.jLjuuY'),
            pvpactual: getText('span.sc-e2aca368-0.sc-2628e4d4-5.juwGno.ehTQUi'),
            envio: getText('div.sc-2628e4d4-9.jAXbur'),
            imagen: getSrc('img.imgSmall'),
            linkproducto: window.location.href
          };
        });

        producto.queryOriginal = query;
        resultados.push(producto);
        await productPage.close();

      } catch (err) {
        console.warn(`No se encontró producto para ${query}:`, err.message);
      }
    }

    res.json(resultados);

  } catch (error) {
    console.error('Error general durante scraping:', error);
    res.status(500).send('Error durante el scraping');
  } finally {
    setTimeout(async () => {
      await browser.close();
    }, 5000);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
