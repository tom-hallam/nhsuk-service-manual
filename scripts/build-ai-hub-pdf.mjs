import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

import axios from 'axios'
import * as cheerio from 'cheerio'

const run = promisify(execFile)

const { values: options } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4000' },
    site: { type: 'string', default: 'https://service-manual.nhs.uk' },
    out: { type: 'string', default: 'app/assets/ai/ai-hub.pdf' },
    browser: { type: 'string' },
    help: { type: 'boolean', short: 'h' }
  }
})

const helpText = `Build a single PDF of the artificial-intelligence pages.

Requires the service manual to be running (npm start) and Edge or Chrome installed.

Usage: node scripts/build-ai-hub-pdf.mjs [options]

  --out <file>      PDF to write (default: app/assets/ai/ai-hub.pdf, served at /assets/ai/ai-hub.pdf)
  --base <url>      Running service manual to read pages from (default: http://localhost:4000)
  --site <url>      Site that links to pages outside the hub point at (default: https://service-manual.nhs.uk)
  --browser <path>  Edge or Chrome executable (default: detected)`

const base = (options.base ?? '').replace(/\/$/, '')
const site = (options.site ?? '').replace(/\/$/, '')
const hubPath = '/artificial-intelligence'
const viewsDir = fileURLToPath(
  new URL('../app/views/artificial-intelligence', import.meta.url)
)

// Reading order follows the hub side navigation; pages not listed are appended
const order = [
  'index',
  'ai-policy-and-guidance',
  'ai-tools',
  'get-started-with-github-copilot',
  'using-ai-to-support-design',
  'using-ai-to-support-user-research',
  'processing-research-data-with-ai-tools',
  'using-ai-to-support-content-design',
  'standards-to-follow',
  'transparency-and-assurance',
  'learning-and-development-resources',
  'get-involved-sharing-good-practice'
]

const mimeTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

const printCss = `
@page { size: A4; margin: 16mm 14mm; }
body { background: #fff; }
a[href]::after { content: none !important; }
.pdf-cover { padding-top: 24mm; }
.pdf-cover h1 { margin-bottom: 8mm; }
.pdf-toc, .pdf-toc ul { list-style: none; margin: 0; padding: 0; }
.pdf-toc > li { margin-top: 3mm; font-weight: 600; }
.pdf-toc ul { margin: 1mm 0 0 6mm; font-weight: 400; }
.pdf-page { break-before: page; }
.pdf-page img { max-width: 100%; height: auto; }
.pdf-page table { width: 100%; font-size: 10pt; }
.pdf-page th, .pdf-page td { overflow-wrap: break-word; }
.pdf-page tr, .pdf-page figure, .pdf-page img { break-inside: avoid; }
.pdf-page h2, .pdf-page h3, .pdf-page h4 { break-after: avoid; }
`

const requestTimeout = 180_000

async function fetchText(url) {
  const response = await axios.get(url, {
    responseType: 'text',
    timeout: requestTimeout
  })
  return String(response.data)
}

async function fetchBuffer(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: requestTimeout
  })
  return Buffer.from(response.data)
}

async function listSlugs() {
  const found = (await readdir(viewsDir))
    .filter((name) => name.endsWith('.njk') && !name.startsWith('_'))
    .map((name) => name.replace(/\.njk$/, ''))

  return [
    ...order.filter((slug) => found.includes(slug)),
    ...found.filter((slug) => !order.includes(slug)).sort()
  ]
}

async function inlineImages($, root) {
  for (const img of root.find('img[src]').toArray()) {
    const src = $(img).attr('src') ?? ''
    const type = mimeTypes[extname(src.split('?')[0]).toLowerCase()]

    if (src.startsWith('/') && type) {
      const data = await fetchBuffer(base + src)
      $(img).attr('src', `data:${type};base64,${data.toString('base64')}`)
    }
  }
}

async function loadPage(slug) {
  const route = slug === 'index' ? hubPath : `${hubPath}/${slug}`
  const $ = cheerio.load(await fetchText(base + route))
  const root = $('.app-pane__main-content').first()

  if (!root.length) throw new Error(`No page content found at ${route}`)

  root.find('.app-index-navigation, [data-pdf-exclude], script, nav').remove()

  const title = root
    .find('h1')
    .first()
    .clone()
    .find('.nhsuk-caption-xl')
    .remove()
    .end()
    .text()
    .replace(/\s+/g, ' ')
    .trim()

  root.find('[id]').each((_, el) => {
    $(el).attr('id', `${slug}--${$(el).attr('id')}`)
  })

  let count = 0
  const headings = []
  root.find('h2').each((_, el) => {
    if (!$(el).attr('id')) $(el).attr('id', `${slug}--section-${++count}`)
    headings.push({
      id: $(el).attr('id'),
      text: $(el).text().replace(/\s+/g, ' ').trim()
    })
  })

  await inlineImages($, root)

  return { slug, title, headings, $, root }
}

function rewriteLinks(pages) {
  const slugs = new Set(pages.map((page) => page.slug))
  const ids = new Set(pages.map((page) => `page-${page.slug}`))
  const internal = []

  for (const { $, root } of pages) {
    root.find('[id]').each((_, el) => ids.add($(el).attr('id')))
  }

  for (const { slug, $, root } of pages) {
    root.find('a[href]').each((_, el) => {
      const href = $(el).attr('href')

      if (href.startsWith('#')) {
        if (href.length > 1) $(el).attr('href', `#${slug}--${href.slice(1)}`)
      } else if (href.startsWith('/')) {
        const url = new URL(href, base)
        const match = url.pathname.match(
          /^\/artificial-intelligence(?:\/([^/]+))?\/?$/
        )
        const target = match && (match[1] ?? 'index')

        if (target && slugs.has(target)) {
          $(el).attr(
            'href',
            url.hash ? `#${target}--${url.hash.slice(1)}` : `#page-${target}`
          )
        } else {
          $(el).attr('href', site + href)
        }
      }

      $(el).removeAttr('target')

      const current = $(el).attr('href')
      if (current.startsWith('#')) internal.push({ slug, href: current })
    })
  }

  return internal.filter(({ href }) => !ids.has(href.slice(1)))
}

function findBrowser() {
  const candidates = [
    options.browser,
    process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ]

  const found = candidates.find((path) => path && existsSync(path))
  if (!found) {
    throw new Error('Edge or Chrome not found. Pass one with --browser <path>')
  }
  return found
}

function buildHtml(pages, css) {
  const contents = pages
    .map(
      ({ slug, title, headings }) => `
      <li><a href="#page-${slug}">${title}</a>
        ${
          headings.length
            ? `<ul>${headings
                .map(({ id, text }) => `<li><a href="#${id}">${text}</a></li>`)
                .join('')}</ul>`
            : ''
        }
      </li>`
    )
    .join('')

  const sections = pages
    .map(
      ({ slug, root }) =>
        `<section class="pdf-page" id="page-${slug}">${root.html()}</section>`
    )
    .join('\n')

  const generated = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>Artificial Intelligence and User-Centred Design at NHS England</title>
<style>${css}</style>
<style>${printCss}</style>
</head>
<body>
<div class="nhsuk-width-container">
<section class="pdf-cover">
  <h1>Artificial Intelligence and User-Centred Design at NHS England</h1>
  <p class="nhsuk-body-s">Compiled ${generated}. Links within this document jump to the relevant section.</p>
  <h2>Contents</h2>
  <ol class="pdf-toc">${contents}</ol>
</section>
${sections}
</div>
</body>
</html>`
}

async function main() {
  if (options.help) {
    console.log(helpText)
    return
  }

  const slugs = await listSlugs()
  console.log(`Reading ${slugs.length} pages from ${base}`)

  const pages = []
  for (const slug of slugs) {
    console.log(`  ${slug}`)
    pages.push(await loadPage(slug))
  }

  for (const { slug, href } of rewriteLinks(pages)) {
    console.warn(
      `Warning: ${slug} links to ${href}, which is not in the document`
    )
  }

  const css = (await fetchText(`${base}/stylesheets/main.css`)).replace(
    /url\((['"]?)\/(?!\/)/g,
    `url($1${base}/`
  )

  const temp = await mkdtemp(join(tmpdir(), 'ai-hub-pdf-'))
  const htmlPath = join(temp, 'ai-hub.html')
  const outPath = resolve(options.out ?? 'app/assets/ai/ai-hub.pdf')

  try {
    await writeFile(htmlPath, buildHtml(pages, css))

    await run(
      findBrowser(),
      [
        '--headless=new',
        '--disable-gpu',
        '--no-pdf-header-footer',
        '--generate-pdf-document-outline',
        `--user-data-dir=${join(temp, 'profile')}`,
        `--print-to-pdf=${outPath}`,
        pathToFileURL(htmlPath).href
      ],
      { timeout: 300_000 }
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }

  if (!existsSync(outPath)) throw new Error(`PDF was not created at ${outPath}`)
  console.log(`Wrote ${outPath}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
