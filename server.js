import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import crypto from "crypto";
import multer from "multer";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PINTEREST_API_BASE = "https://api.pinterest.com/v5";
const PINTEREST_OAUTH_BASE = "https://www.pinterest.com";
const pinterestConfig = {
  appId: process.env.PINTEREST_APP_ID,
  appSecret: process.env.PINTEREST_APP_SECRET,
  redirectUri:
    process.env.PINTEREST_REDIRECT_URI ||
    `http://localhost:${port}/auth/pinterest/callback`,
  scopes:
    process.env.PINTEREST_SCOPES ||
    "user_accounts:read,boards:read,pins:write",
};

let pinterestToken = null;
let pinterestOauthState = null;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

const pinSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    product_name: { type: "string" },
    categories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category_name: { type: "string" },
          keyword: { type: "string" },
          search_intent: { type: "string" },
          angle: { type: "string" },
          board_name: { type: "string" },
          board_description: { type: "string" },
          tagged_topics: {
            type: "array",
            items: { type: "string" },
          },
          pins: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                hashtags: {
                  type: "array",
                  items: { type: "string" },
                },
                image_hook: { type: "string" },
                pin_style: { type: "string" },
              },
              required: ["title", "description", "hashtags", "image_hook", "pin_style"],
            },
          },
        },
        required: [
          "category_name",
          "keyword",
          "search_intent",
          "angle",
          "board_name",
          "board_description",
          "tagged_topics",
          "pins",
        ],
      },
    },
  },
  required: ["product_name", "categories"],
};

function requirePinterestAuth(req, res, next) {
  if (!pinterestToken?.access_token) {
    return res.status(401).json({
      error:
        "Pinterest is not connected. Click “Connect Pinterest” in the UI first.",
    });
  }
  next();
}

app.get("/api/pinterest/status", (req, res) => {
  res.json({
    connected: Boolean(pinterestToken?.access_token),
    scope: pinterestToken?.scope || null,
    expires_in: pinterestToken?.expires_in || null,
  });
});

app.get("/auth/pinterest", (req, res) => {
  const { appId, redirectUri, scopes } = pinterestConfig;

  if (!appId) {
    return res.status(500).send("Missing PINTEREST_APP_ID in .env");
  }

  pinterestOauthState = crypto.randomBytes(16).toString("hex");

  const authUrl =
    `${PINTEREST_OAUTH_BASE}/oauth/?` +
    `consumer_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(pinterestOauthState)}`;

  res.redirect(authUrl);
});

app.get("/auth/pinterest/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query ?? {};

    if (error) {
      return res
        .status(400)
        .send(`Pinterest OAuth error: ${error_description || error}`);
    }

    if (!code) {
      return res.status(400).send("Missing OAuth code from Pinterest.");
    }

    if (pinterestOauthState && state && state !== pinterestOauthState) {
      return res.status(400).send("Invalid OAuth state.");
    }

    const { appId, appSecret, redirectUri } = pinterestConfig;

    if (!appId || !appSecret) {
      return res
        .status(500)
        .send("Missing PINTEREST_APP_ID or PINTEREST_APP_SECRET in .env");
    }

    const params = new URLSearchParams();
    params.set("grant_type", "authorization_code");
    params.set("code", String(code));
    params.set("redirect_uri", redirectUri);

    const basic = Buffer.from(`${appId}:${appSecret}`).toString("base64");

    const tokenRes = await fetch(`${PINTEREST_API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const tokenJson = await tokenRes.json().catch(() => null);

    if (!tokenRes.ok) {
      const msg =
        tokenJson?.message ||
        tokenJson?.error_description ||
        `Token exchange failed (${tokenRes.status})`;
      throw new Error(msg);
    }

    pinterestToken = {
      ...tokenJson,
      _obtained_at: Date.now(),
    };
    pinterestOauthState = null;

    res.redirect("/?pinterest=connected");
  } catch (e) {
    console.error("Pinterest OAuth callback error:", e);
    res.status(500).send(`Pinterest OAuth callback failed: ${e?.message || e}`);
  }
});

app.post("/api/pinterest/logout", (req, res) => {
  pinterestToken = null;
  pinterestOauthState = null;
  res.json({ ok: true });
});

app.get("/api/pinterest/boards", requirePinterestAuth, async (req, res) => {
  try {
    const boardsRes = await fetch(
      `${PINTEREST_API_BASE}/boards?page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${pinterestToken.access_token}`,
        },
      },
    );

    const boardsJson = await boardsRes.json().catch(() => null);

    if (!boardsRes.ok) {
      const msg =
        boardsJson?.message ||
        boardsJson?.error ||
        `Failed to fetch boards (${boardsRes.status})`;
      return res.status(boardsRes.status).json({ error: msg, details: boardsJson });
    }

    res.json(boardsJson);
  } catch (e) {
    console.error("Boards list error:", e);
    res.status(500).json({ error: e?.message || "Boards list failed." });
  }
});

app.post(
  "/api/pinterest/pins",
  requirePinterestAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const { boardId, title, description, link, altText } = req.body ?? {};

      if (!boardId) {
        return res.status(400).json({ error: "boardId is required." });
      }

      if (!req.file?.buffer) {
        return res.status(400).json({ error: "image file is required." });
      }

      const contentType = req.file.mimetype;
      if (contentType !== "image/jpeg" && contentType !== "image/png") {
        return res.status(400).json({
          error: "Only JPEG or PNG images are supported for Pinterest upload.",
        });
      }

      const createBody = {
        board_id: String(boardId),
        title: title ? String(title).slice(0, 100) : null,
        description: description ? String(description).slice(0, 800) : null,
        link: link ? String(link).slice(0, 2048) : null,
        alt_text: altText ? String(altText).slice(0, 500) : null,
        media_source: {
          source_type: "image_base64",
          content_type: contentType,
          data: req.file.buffer.toString("base64"),
        },
      };

      const pinRes = await fetch(`${PINTEREST_API_BASE}/pins`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pinterestToken.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createBody),
      });

      const pinJson = await pinRes.json().catch(() => null);

      if (!pinRes.ok) {
        const msg =
          pinJson?.message ||
          pinJson?.error ||
          `Failed to create pin (${pinRes.status})`;
        return res.status(pinRes.status).json({ error: msg, details: pinJson });
      }

      res.json(pinJson);
    } catch (e) {
      console.error("Create pin error:", e);
      res.status(500).json({ error: e?.message || "Create pin failed." });
    }
  },
);

app.post("/api/generate", async (req, res) => {
  try {
    const {
      productTitle,
      productDescription,
      categoriesCount = 8,
      pinsPerCategory = 5,
      tone = "viral but not spammy",
      excludeWords = "Amazon",
      targetAudience = "women interested in beauty, skincare, and self care",
      goal = "maximize Pinterest clicks and affiliate conversions",
      platform = "Pinterest",
    } = req.body ?? {};

    const safeCategoriesCount = Math.min(Math.max(Number(categoriesCount) || 8, 1), 12);
    const safePinsPerCategory = Math.min(Math.max(Number(pinsPerCategory) || 5, 1), 10);

    if (!productTitle || !productDescription) {
      return res.status(400).json({
        error: "productTitle și productDescription sunt obligatorii.",
      });
    }

    const prompt = `
You are an elite Pinterest affiliate content strategist and conversion-focused SEO generator.

Your job is not to write generic Pinterest content.
Your job is to generate Pinterest pin ideas that can realistically attract search traffic, improve click-through rate, get saves, and maximize affiliate conversion potential.

Think like this:
- You have no money
- You need traffic
- You need clicks
- You need content that can realistically help sell products
- You must avoid weak, generic, boring, or overly safe ideas

You must think like a smart Pinterest affiliate marketer who wants results, not just pretty writing.

OUTPUT LANGUAGE:
- English only

STRICT RULES:
- Create exactly ${safeCategoriesCount} categories
- Create exactly ${safePinsPerCategory} pins per category
- Titles must feel natural, clickable, and relevant to Pinterest users
- Descriptions must be between 200 and 320 characters
- Descriptions must include natural keywords without stuffing
- Each pin must include 4 to 6 hashtags
- Avoid using these words unless truly necessary: ${excludeWords}
- Tone: ${tone}
- Do not sound robotic
- Do not sound like classroom SEO
- Do not write vague filler
- Do not make fake medical claims
- Do not promise impossible results
- Do not use fake urgency, fake scarcity, or scammy language
- Prefer hooks that target problem-aware, solution-aware, or product-discovery users
- Prioritize categories that can realistically get clicks, saves, or affiliate conversions
- Prefer angles that can be turned into multiple visual Pinterest pin variations
- Make the content useful for a person trying to earn money with affiliate-style Pinterest content

TARGET AUDIENCE:
${targetAudience}

MAIN BUSINESS GOAL:
${goal}

PLATFORM:
${platform}

PRODUCT TITLE:
${productTitle}

PRODUCT DESCRIPTION:
${productDescription}

STRATEGY INSTRUCTIONS:
Choose categories that are most likely to perform for this product on Pinterest.

Strong categories may include, when relevant:
- Problem / Solution
- Routine
- Ingredient / Clean Beauty
- Before / After
- Viral / Discovery
- Tips
- Product Benefits
- Seasonal
- Gift / Lifestyle
- Comparison Style
- Beginner Friendly
- Daily Routine
- Transformation
- Search-driven evergreen
- Buyer intent
- Product discovery

For each category, select an angle that could realistically:
- rank in Pinterest search
- get saved
- get clicked
- attract a buyer or high-intent visitor

Avoid weak or generic categories if better ones exist.

FOR EACH CATEGORY RETURN:
- category_name
- keyword
- search_intent
- angle
- board_name
- board_description
- tagged_topics
- pins

FOR EACH PIN RETURN:
- title
- description
- hashtags
- image_hook
- pin_style

PIN WRITING RULES:
- Titles should feel like real Pinterest titles people would click
- Some titles should be search-focused
- Some titles should be CTR-focused
- Some titles should be problem-aware
- Some titles should be product-discovery focused
- Avoid repeating the same title pattern too often
- Make each pin feel distinct enough to justify a separate post

DESCRIPTION RULES:
- The first sentence should naturally support the keyword or main idea
- Descriptions should feel useful and commercially relevant
- Do not repeat the title word-for-word
- Do not overuse brand names
- Keep the tone natural, sharp, and practical
- Write like someone trying to earn affiliate clicks honestly, not like a spammer

IMAGE_HOOK RULES:
- Keep it short
- Strong enough to use as text overlay on the pin image
- Prefer 2 to 6 words
- Make it emotionally clear or curiosity-driven
- Examples:
  - Dry Lips?
  - Fix Thinning Hair
  - Better Scalp Routine
  - Fuller Hair Starts Here
  - Soft Hands Overnight
  - Dry Hands Fix

PIN_STYLE RULES:
Use practical visual directions such as:
- bold problem-solution
- clean beauty
- before-after
- routine aesthetic
- ingredient infographic
- viral product style
- premium product focus
- educational tip pin
- search-first minimal pin
- buyer-intent commercial pin

IMPORTANT:
Generate output that feels commercially smart, Pinterest-native, and realistic for someone trying to get traffic and sales.
Do not generate lazy generic ideas.
Do not play safe unless necessary.
`;

    const response = await client.responses.create({
      model: "gpt-4o-mini",
      store: false,
      input: prompt,
      text: {
        format: {
          type: "json_schema",
          name: "pinterest_pin_plan",
          description:
            "Structured Pinterest affiliate pin strategy with categories, hooks, SEO titles, descriptions, hashtags, board suggestions, search intent, and pin styles.",
          strict: true,
          schema: pinSchema,
        },
      },
    });

    const jsonText =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      null;

    if (!jsonText) {
      throw new Error("No structured JSON returned by the model.");
    }

    const parsed = JSON.parse(jsonText);

    res.json(parsed);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Generation error",
      details: error.message,
    });
  }
});

app.listen(port, () => {
  console.log("Server running on http://localhost:" + port);
});