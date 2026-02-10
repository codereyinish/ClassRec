# 📚 Lecture Transcription System

AI-powered transcription system for students built with FastAPI and OpenAI Whisper API.

## Features

- ✅ **File Upload Transcription** - Upload audio files and get instant transcription
- 🚧 **Live Recording** (Coming Soon) - Record and transcribe in real-time

## Tech Stack

- **Backend:** FastAPI
- **AI:** OpenAI Whisper API
- **Frontend:** HTML, CSS, JavaScript
- **Deployment:** Render

## Setup

### Prerequisites
- Python 3.11+
- OpenAI API Key

### Installation

1. Clone the repository
```bash
git clone https://github.com/codereyinish/ClassRec.git
cd ClassRec
```

2. Create virtual environment
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies
```bash
pip install -r requirements.txt
```

4. Create `.env` file
```bash
echo "OPENAI_API_KEY=your-api-key-here" > .env
```

5. Run the application
```bash
uvicorn main:app --reload
```

6. Open browser
```
http://localhost:8000
```

## Deployment

Deployed on Render: 🔗 https://classrec.onrender.com

## License

MIT

## Author

**Inish** - MBCodes
