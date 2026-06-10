// Safe storage wrapper to prevent crashes in environments where localStorage is blocked (e.g. local file:// protocol)
const safeStorage = {
    getItem(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            console.warn(`localStorage.getItem failed for key "${key}":`, e);
            return null;
        }
    },
    setItem(key, value) {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch (e) {
            console.warn(`localStorage.setItem failed for key "${key}":`, e);
            return false;
        }
    }
};

// Safe JSON parsing helper
function safeJSONParse(key, defaultValue) {
    try {
        const item = safeStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
        console.error(`Error parsing key "${key}" from storage:`, e);
        return defaultValue;
    }
}

// Parse state with validation
const parsedSubjects = safeJSONParse('study_subjects', []);
const parsedTasks = safeJSONParse('study_completed_tasks', {});
let parsedHours = parseFloat(safeStorage.getItem('study_daily_hours'));
if (isNaN(parsedHours) || parsedHours <= 0) {
    parsedHours = 4;
}

let state = {
    subjects: Array.isArray(parsedSubjects) ? parsedSubjects : [],
    dailyHours: parsedHours,
    lastComputedDate: safeStorage.getItem('study_last_date') || '',
    completedTasks: (parsedTasks && typeof parsedTasks === 'object') ? parsedTasks : {}
};

let currentSchedule = [];

// Check if it's a new day to reset completed tasks
const todayStr = new Date().toDateString();
if (state.lastComputedDate !== todayStr) {
    state.completedTasks = {};
    state.lastComputedDate = todayStr;
    saveState();
}

// DOM Elements
const formSubject = document.getElementById('add-subject-form');
const formSettings = document.getElementById('settings-form');
const statSubjects = document.getElementById('stat-subjects');
const statHours = document.getElementById('stat-hours');
const statProgress = document.getElementById('stat-progress');
const taskList = document.getElementById('task-list');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressPercentLarge = document.getElementById('progress-percent-large');
const inputDailyHours = document.getElementById('daily-hours');
const currentDateEl = document.getElementById('current-date');

// Set current date badge
currentDateEl.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

// --- Initialization ---
function init() {
    inputDailyHours.value = state.dailyHours;
    renderApp();
}

// --- Save State ---
function saveState() {
    safeStorage.setItem('study_subjects', JSON.stringify(state.subjects));
    safeStorage.setItem('study_daily_hours', state.dailyHours);
    safeStorage.setItem('study_last_date', state.lastComputedDate);
    safeStorage.setItem('study_completed_tasks', JSON.stringify(state.completedTasks));
}

// --- Event Listeners ---
formSubject.addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('subject');
    const dateInput = document.getElementById('exam-date');
    
    const newSubject = {
        id: 'subj_' + Date.now(),
        name: nameInput.value,
        examDate: dateInput.value
    };
    
    state.subjects.push(newSubject);
    saveState();
    
    nameInput.value = '';
    dateInput.value = '';
    
    showToast(`Added ${newSubject.name} to your plan.`, 'success');
    renderApp();
});

formSettings.addEventListener('submit', (e) => {
    e.preventDefault();
    const parsedHours = parseFloat(inputDailyHours.value);
    if (!isNaN(parsedHours) && parsedHours > 0) {
        state.dailyHours = parsedHours;
        saveState();
        showToast(`Daily availability updated to ${state.dailyHours}h.`, 'success');
        renderApp();
    } else {
        showToast(`Please enter a valid number of hours.`, 'error');
    }
});

// Mock Integrations & Exports
document.getElementById('btn-sync-cal').addEventListener('click', () => {
    if (currentSchedule.length === 0) {
        showToast('No tasks to export today. Add subjects first.', 'info');
        return;
    }
    exportToICS(currentSchedule);
    showToast('Schedule exported! You can import this into Google Calendar.', 'success');
});

document.getElementById('btn-notify').addEventListener('click', () => {
    showToast('Push notifications enabled.', 'success');
});

// --- Core Algorithm & Rendering ---

function renderApp() {
    statSubjects.textContent = state.subjects.length;
    statHours.textContent = state.dailyHours + 'h';
    
    if (state.subjects.length === 0) {
        taskList.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-list-dashes"></i>
                <p>Add subjects and set your availability to generate your plan.</p>
            </div>
        `;
        updateProgress(0, 0);
        return;
    }
    
    // 1. Calculate Priorities
    const today = new Date();
    today.setHours(0,0,0,0);
    
    let totalPriority = 0;
    const subjectsWithPriority = state.subjects.map(subj => {
        let examDate = new Date(subj.examDate);
        if (isNaN(examDate.getTime())) {
            // Fallback to today + 7 days
            examDate = new Date(today);
            examDate.setDate(examDate.getDate() + 7);
        }
        const timeDiff = examDate.getTime() - today.getTime();
        // Calculate days difference, minimum 0 (exam is today or past)
        const daysDiff = Math.max(0, Math.ceil(timeDiff / (1000 * 3600 * 24)));
        
        // Priority formula: inversely proportional to days remaining. +1 to avoid div by zero.
        const priority = 1 / (daysDiff + 1);
        totalPriority += priority;
        
        return { ...subj, daysDiff, priority };
    });
    
    // Guard against divide by zero or NaN totalPriority
    if (isNaN(totalPriority) || totalPriority <= 0) {
        totalPriority = 1;
    }
    
    // 2. Allocate Time
    let totalAllocatedMins = 0;
    let scheduledTasks = subjectsWithPriority.map(subj => {
        const weight = totalPriority > 0 ? (subj.priority / totalPriority) : (1 / subjectsWithPriority.length);
        // Ensure dailyHours is valid
        const dailyHours = isNaN(state.dailyHours) || state.dailyHours <= 0 ? 4 : state.dailyHours;
        // Raw minutes allocated
        const rawMins = weight * dailyHours * 60;
        
        // Round to nearest 15 mins for cleaner schedule
        let allocatedMins = Math.round(rawMins / 15) * 15;
        
        // Enforce a minimum of 15 mins if subject exists
        if (allocatedMins === 0 || isNaN(allocatedMins)) allocatedMins = 15;
        
        totalAllocatedMins += allocatedMins;
        
        return {
            ...subj,
            allocatedMins,
            allocatedFormatted: formatMinutes(allocatedMins)
        };
    });
    
    // Normalize if total allocated exceeds daily hours significantly due to rounding
    const maxMins = state.dailyHours * 60;
    if (totalAllocatedMins > maxMins) {
        // Simple reduction on the largest allocated subject
        scheduledTasks.sort((a,b) => b.allocatedMins - a.allocatedMins);
        const diff = totalAllocatedMins - maxMins;
        if(scheduledTasks[0].allocatedMins > diff + 15) {
             scheduledTasks[0].allocatedMins -= diff;
             scheduledTasks[0].allocatedFormatted = formatMinutes(scheduledTasks[0].allocatedMins);
        }
    }
    
    // Sort by exam date (closest first)
    scheduledTasks.sort((a, b) => a.daysDiff - b.daysDiff);
    
    currentSchedule = scheduledTasks;
    
    // 3. Render Tasks
    taskList.innerHTML = '';
    let completedMins = 0;
    let finalTotalMins = 0;
    
    scheduledTasks.forEach(task => {
        finalTotalMins += task.allocatedMins;
        const isCompleted = state.completedTasks[task.id] === true;
        const isDueToday = task.daysDiff === 0;
        
        if (isCompleted) {
            completedMins += task.allocatedMins;
        }
        
        const taskEl = document.createElement('div');
        taskEl.className = `task-item ${isCompleted ? 'completed' : ''} ${isDueToday && !isCompleted ? 'due-today' : ''}`;
        taskEl.innerHTML = `
            <div class="task-left">
                <div class="checkbox ${isCompleted ? 'checked' : ''}" data-id="${task.id}">
                    <i class="ph ph-check-bold"></i>
                </div>
                <div class="task-details">
                    <span class="task-name">Study ${task.name}</span>
                    <span class="task-meta">
                        ${isDueToday ? '<span class="badge-today">Due Today!</span>' : ''}
                        Exam in ${task.daysDiff} days
                    </span>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
                <div class="task-duration">
                    <i class="ph ph-clock"></i> ${task.allocatedFormatted}
                </div>
                <button class="task-delete" data-id="${task.id}" title="Remove Subject">
                    <i class="ph ph-trash"></i>
                </button>
            </div>
        `;
        taskList.appendChild(taskEl);
    });
    
    updateProgress(completedMins, finalTotalMins);
    attachTaskListeners();
}

function formatMinutes(mins) {
    if (isNaN(mins) || mins <= 0) return "0m";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

function updateProgress(completedMins, totalMins) {
    if (isNaN(totalMins) || totalMins === 0) {
        progressBar.style.width = '0%';
        progressText.textContent = `0/0 hours`;
        statProgress.textContent = '0%';
        if(progressPercentLarge) progressPercentLarge.textContent = '0%';
        return;
    }
    const percent = Math.round((completedMins / totalMins) * 100);
    progressBar.style.width = `${percent}%`;
    
    const compFormatted = (completedMins / 60).toFixed(1).replace('.0', '');
    const totalFormatted = (totalMins / 60).toFixed(1).replace('.0', '');
    
    progressText.textContent = `${compFormatted}/${totalFormatted} hours`;
    statProgress.textContent = `${percent}%`;
    if(progressPercentLarge) progressPercentLarge.textContent = `${percent}%`;
}

function attachTaskListeners() {
    // Checkbox toggling
    document.querySelectorAll('.checkbox').forEach(box => {
        box.addEventListener('click', (e) => {
            const id = box.getAttribute('data-id');
            state.completedTasks[id] = !state.completedTasks[id];
            saveState();
            renderApp();
            
            if (state.completedTasks[id]) {
                const percent = parseInt(statProgress.textContent);
                if(percent === 100) {
                    showToast('Amazing! You finished all tasks for today! 🎉', 'success');
                }
            }
        });
    });
    
    // Delete subject
    document.querySelectorAll('.task-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = btn.getAttribute('data-id');
            state.subjects = state.subjects.filter(s => s.id !== id);
            delete state.completedTasks[id];
            saveState();
            showToast('Subject removed.', 'info');
            renderApp();
        });
    });
}

// --- Toast UI ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'ph-check-circle' : 'ph-info';
    
    toast.innerHTML = `
        <i class="ph ${icon}"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(toast);
    
    // Animate in
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    
    // Remove after 3s
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- Calendar Export ---
function exportToICS(tasks) {
    let icsContent = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Smart AI Study Planner//EN\r\n";
    
    // Start scheduling tasks today at 9:00 AM
    let startHour = 9; 
    let startMin = 0;
    const today = new Date();
    
    tasks.forEach(task => {
        if (task.allocatedMins <= 0) return;
        
        const start = new Date(today);
        start.setHours(startHour, startMin, 0, 0);
        
        // Add duration
        const end = new Date(start.getTime() + task.allocatedMins * 60000);
        
        icsContent += "BEGIN:VEVENT\r\n";
        icsContent += `SUMMARY:Study ${task.name}\r\n`;
        icsContent += `DESCRIPTION:AI Generated Study Session - Exam in ${task.daysDiff} days.\r\n`;
        icsContent += `DTSTART:${formatICSDate(start)}\r\n`;
        icsContent += `DTEND:${formatICSDate(end)}\r\n`;
        icsContent += "END:VEVENT\r\n";
        
        // Update start time for next task (add a 10 min break)
        startHour = end.getHours();
        startMin = end.getMinutes() + 10;
        if(startMin >= 60) {
            startHour += 1;
            startMin -= 60;
        }
    });
    
    icsContent += "END:VCALENDAR";
    
    // Create and download file
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const link = document.createElement('a');
    link.href = window.URL.createObjectURL(blob);
    link.download = 'study_schedule.ics';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function formatICSDate(date) {
    return date.toISOString().replace(/-|:|\.\d+/g, '').substring(0, 15) + 'Z';
}

// Start app
init();
