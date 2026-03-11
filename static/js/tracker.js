const LIMITS = {
    UPLOAD_TOTAL_MINUTES: 15,
    UPLOAD_MAX_PER_FILE: 10,
    LIVE_TOTAL_MINUTES:10}

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
        if(fileDurationMins > LIMITS.UPLOAD_MAX_PER_FILE) return {allowed: false , reason: "File too long. Max 10 minutes per file for freemium users."};
         if (this.getUploadMinutes() + fileDurationMins > LIMITS.UPLOAD_TOTAL_MINUTES) return { allowed: false, reason:
         "You have used all 20 free upload minutes." };
         return { allowed: true };
    },
    canRecordLive(){
         return this.getLiveMinutes() < LIMITS.LIVE_TOTAL_MINUTES;
    },
    getRemainingLiveSeconds() {
        return Math.max(0, (LIMITS.LIVE_TOTAL_MINUTES - this.getLiveMinutes()) * 60);
    }



}

