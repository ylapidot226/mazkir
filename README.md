# מזכיר - העוזר החכם שלך בוואטסאפ 🤖

בוט וואטסאפ חכם שמשמש כמזכיר אישי — מנהל תזכורות, אירועים ומשימות בשפה טבעית בעברית.

## מה המערכת עושה?

- **אירועים חכמים** — מבין תאריכים בשפה טבעית ("עוד שבועיים", "מחר בצהריים") ושומר עם תזכורות אוטומטיות
- **משימות ופרויקטים** — ניהול משימות לפי קטגוריות מותאמות אישית
- **רשימות קניות** — הוספה, שליפה ומחיקה של פריטים
- **תזכורות** — 24 שעות לפני אירוע + תזכורת ביום עצמו
- **ממשק אדמין** — אישור משתמשים חדשים וסטטיסטיקות
- **דף נחיתה** — דף הרשמה מעוצב לרשימת ממתינים

## דרישות מוקדמות

- Node.js 18+
- חשבון [Supabase](https://supabase.com) (חינמי)
- חשבון [Green API](https://green-api.com) עם instance פעיל
- מפתח API של [Anthropic](https://console.anthropic.com)

## התקנה

### 1. שכפול הפרויקט

```bash
cd mazkir
npm install
```

### 2. הגדרת Supabase

1. צור פרויקט חדש ב-[Supabase](https://supabase.com)
2. לך ל-SQL Editor
3. העתק את התוכן של `supabase/schema.sql` והרץ אותו
4. העתק את ה-URL וה-anon key מ-Settings > API

### 3. הגדרת Green API

1. צור חשבון ב-[Green API](https://green-api.com)
2. צור instance חדש וסרוק את הקוד עם וואטסאפ
3. העתק את ה-Instance ID וה-API Token
4. בהגדרות ה-instance, הגדר:
   - **Webhook URL**: `https://your-domain.com/webhook/whatsapp`
   - סמן: `incomingMessageReceived`
   - בטל סימון של כל שאר סוגי ה-webhooks (אם לא צריך)

### 4. הגדרת משתני סביבה

```bash
cp .env.example .env
```

ערוך את `.env`:

```
GREEN_API_INSTANCE_ID=your_instance_id
GREEN_API_TOKEN=your_api_token
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=eyJ...
ADMIN_PASSWORD=your_admin_password
PORT=3000
```

### 5. הרצה

```bash
# פיתוח (עם auto-reload)
npm run dev

# פרודקשן
npm start
```

## כתובות

| כתובת | תיאור |
|--------|--------|
| `http://localhost:3000` | דף נחיתה |
| `http://localhost:3000/admin.html` | פאנל ניהול |
| `http://localhost:3000/webhook/whatsapp` | Webhook endpoint |
| `http://localhost:3000/health` | Health check |

## איך להעלות לפרודקשן

### אפשרות 1: Railway / Render

1. העלה את הקוד ל-GitHub
2. חבר ל-[Railway](https://railway.app) או [Render](https://render.com)
3. הגדר את משתני הסביבה
4. עדכן את ה-Webhook URL ב-Green API לכתובת הפרודקשן

### אפשרות 2: VPS

```bash
# עם PM2
npm install -g pm2
pm2 start src/index.js --name mazkir
pm2 save
```

## מבנה הפרויקט

```
mazkir/
├── public/
│   ├── index.html          # דף נחיתה
│   └── admin.html          # פאנל ניהול
├── src/
│   ├── index.js             # נקודת כניסה + Express
│   ├── config.js            # הגדרות
│   ├── routes/
│   │   ├── webhook.js       # Webhook מ-Green API
│   │   └── admin.js         # API לפאנל ניהול
│   ├── services/
│   │   ├── database.js      # Supabase queries
│   │   ├── greenApi.js      # שליחת/קבלת הודעות
│   │   ├── claude.js        # עיבוד שפה טבעית
│   │   └── reminders.js     # Cron jobs לתזכורות
│   └── utils/
│       └── logger.js        # לוגים מובנים
├── supabase/
│   └── schema.sql           # סכמת DB
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## דוגמאות שימוש

| הודעה | תגובה |
|-------|-------|
| "יש לי פגישה מחר ב-10 בבוקר" | ✅ שמרתי! פגישה מחר ב-10:00. אתזכר אותך היום בערב |
| "אני צריך טישו וסבון" | 🛒 הוספתי לרשימת הקניות: טישו, סבון |
| "מה אני צריך לקנות?" | רשימת הקניות שלך: 1. טישו 2. סבון |
| "יש לי פרויקט חתונה" | 📋 פתחתי קטגוריה חדשה: חתונה |
| "הוסף לחתונה: למצוא DJ" | ✅ הוספתי לחתונה: למצוא DJ |
| "מה המשימות לחתונה?" | המשימות שלך בחתונה: 1. למצוא DJ |
