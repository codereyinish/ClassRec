
const MEMBER_LIVE_LIMIT = 25;
const NON_MEMBER_LIVE_LIMIT = 5;
const MEMBER_UPLOAD_LIMIT = 30;
const NON_MEMBER_UPLOAD_LIMIT = 15;
const UPLOAD_MAX_PER_FILE = 10;


function isMember() {
    return !!window.Clerk?.user;  // checked fresh every time
}
function getLiveLimit(){
        return isMember() ? MEMBER_LIVE_LIMIT : NON_MEMBER_LIVE_LIMIT;
}

function getUploadLimit(){
    return isMember() ? MEMBER_UPLOAD_LIMIT  : NON_MEMBER_UPLOAD_LIMIT
}


const STORAGE_KEYS = {
    UPLOAD_MINUTES: 'classrec_upload_minutes',
    LIVE_MINUTES: 'classrec_live_minutes'
};

const UsageTracker = {
    getUploadMinutes() {
        return parseFloat(localStorage.getItem(STORAGE_KEYS.UPLOAD_MINUTES) || '0');
    },
    getLiveMinutes(){
        return parseFloat(localStorage.getItem(STORAGE_KEYS.LIVE_MINUTES) || '0');
    },
    addUploadMinutes(mins){
        localStorage.setItem(STORAGE_KEYS.UPLOAD_MINUTES, (this.getUploadMinutes() + mins).toFixed(2));
    },
    addLiveMinutes(mins){
        localStorage.setItem(STORAGE_KEYS.LIVE_MINUTES, (this.getLiveMinutes() + mins).toFixed(4));
    },
    canUpload(fileDurationMins){
        if(fileDurationMins > UPLOAD_MAX_PER_FILE) return {allowed: false ,
        reason: "File too long. Max 10 minutes per file for freemium users", code: "file_too_long"};
        if (this.getUploadMinutes() + fileDurationMins > getUploadLimit()) return { allowed: false, reason:
         "You have used all 20 free upload minutes.", code: "limit_reached"};
        return { allowed: true };
    },
    canRecordLive(){
         return this.getLiveMinutes() < getLiveLimit();
    },
    getRemainingLiveSeconds() {
        return Math.max(0, (getLiveLimit() - this.getLiveMinutes()) * 60);
    }


}

