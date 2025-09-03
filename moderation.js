import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const PERSPECTIVE_API_KEY = process.env.PERSPECTIVE_API_KEY;
const DISCOVERY_URL = 'https://commentanalyzer.googleapis.com/$discovery/rest?version=v1alpha1';


const THRESHOLDS = {
    TOXICITY: 0.7,
    SEVERE_TOXICITY: 0.6,
    THREAT: 0.8,
    SEXUALLY_EXPLICIT: 0.7,
    INSULT: 0.75
};

async function isContentAppropriate(text) {
    if (!text || text.trim() === '') {
        return true;
    }

    // We wrap the logic in a Promise to maintain the async/await structure in our routes.
    return new Promise((resolve, reject) => {
        google.discoverAPI(DISCOVERY_URL)
            .then(client => {
                const analyzeRequest = {
                    comment: { text: text },
                    requestedAttributes: { 
                        TOXICITY: {}, 
                        SEVERE_TOXICITY: {}, 
                        THREAT: {},
                        SEXUALLY_EXPLICIT: {},
                        INSULT: {}
                    }
                };

                client.comments.analyze({
                    key: PERSPECTIVE_API_KEY,
                    resource: analyzeRequest,
                }, (err, response) => {
                    if (err) {
                        console.error("Perspective API Error:", err.message);
                        // It's safer to flag content if the API fails
                        return resolve(false); 
                    }

                    const scores = response.data.attributeScores;
                    const isUnacceptable = 
                        scores.TOXICITY.summaryScore.value > THRESHOLDS.TOXICITY ||
                        scores.SEVERE_TOXICITY.summaryScore.value > THRESHOLDS.SEVERE_TOXICITY ||
                        scores.THREAT.summaryScore.value > THRESHOLDS.THREAT ||
                        scores.SEXUALLY_EXPLICIT.summaryScore.value > THRESHOLDS.SEXUALLY_EXPLICIT ||
                        scores.INSULT.summaryScore.value > THRESHOLDS.INSULT;

                    // Resolve with true if clean, false if flagged
                    resolve(!isUnacceptable);
                });
            })
            .catch(err => {
                console.error("Error discovering Perspective API:", err.message);
                // Reject the promise if the API itself can't be reached
                reject(err);
            });
    });
}
export { isContentAppropriate };