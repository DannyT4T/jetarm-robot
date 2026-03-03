#!/usr/bin/env python3
"""
JetArm Memory & Learning System
════════════════════════════════
Logs every autonomous action + result to a persistent SQLite database.
Provides context to the AI so it can learn from past successes and failures.

Features:
  - Persistent action log (survives restarts)
  - Success/failure tracking per action type
  - Scene context snapshots (what was visible when acting)
  - Pattern extraction (what worked, what didn't)
  - Query API for the autonomy system

Usage:
  from action_memory import ActionMemory
  
  memory = ActionMemory()
  memory.log_action(goal, action, result, scene_state)
  lessons = memory.get_lessons(goal="pick up", limit=5)
"""
import json
import time
import sqlite3
import os
from pathlib import Path
from datetime import datetime

MEMORY_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'jetarm_memory.db')


class ActionMemory:
    """Persistent memory for robot actions and outcomes."""
    
    def __init__(self, db_path=MEMORY_DB):
        self.db_path = db_path
        self._init_db()
    
    def _init_db(self):
        """Create tables if they don't exist."""
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        
        # Main action log
        c.execute('''CREATE TABLE IF NOT EXISTS actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL,
            goal TEXT,
            step INTEGER,
            action_type TEXT,
            action_json TEXT,
            result TEXT,
            success INTEGER,
            scene_objects TEXT,
            servo_positions TEXT,
            gripper_state TEXT,
            notes TEXT,
            session_id TEXT
        )''')
        
        # Session log (tracks full autonomy runs)
        c.execute('''CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            start_time REAL,
            end_time REAL,
            goal TEXT,
            total_steps INTEGER,
            success INTEGER,
            final_result TEXT
        )''')
        
        # Lessons learned (extracted patterns)
        c.execute('''CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL,
            category TEXT,
            lesson TEXT,
            confidence REAL,
            source_session TEXT
        )''')
        
        conn.commit()
        conn.close()
    
    def start_session(self, goal):
        """Start a new autonomy session."""
        session_id = f"session_{int(time.time())}_{os.getpid()}"
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'INSERT INTO sessions (id, start_time, goal, total_steps, success) VALUES (?, ?, ?, 0, 0)',
            (session_id, time.time(), goal)
        )
        conn.commit()
        conn.close()
        return session_id
    
    def end_session(self, session_id, total_steps, success, final_result=''):
        """End an autonomy session."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'UPDATE sessions SET end_time=?, total_steps=?, success=?, final_result=? WHERE id=?',
            (time.time(), total_steps, 1 if success else 0, final_result, session_id)
        )
        conn.commit()
        conn.close()
    
    def log_action(self, goal, step, action_type, action_json, result, 
                   success, scene_objects=None, servo_positions=None,
                   gripper_state=None, notes=None, session_id=None):
        """Log a single action and its outcome."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            '''INSERT INTO actions 
               (timestamp, goal, step, action_type, action_json, result, success,
                scene_objects, servo_positions, gripper_state, notes, session_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                time.time(), goal, step, action_type,
                json.dumps(action_json) if isinstance(action_json, dict) else str(action_json),
                str(result), 1 if success else 0,
                json.dumps(scene_objects) if scene_objects else None,
                json.dumps(servo_positions) if servo_positions else None,
                gripper_state, notes, session_id
            )
        )
        conn.commit()
        conn.close()
    
    def add_lesson(self, category, lesson, confidence=0.5, source_session=None):
        """Add a learned lesson."""
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            'INSERT INTO lessons (timestamp, category, lesson, confidence, source_session) VALUES (?, ?, ?, ?, ?)',
            (time.time(), category, lesson, confidence, source_session)
        )
        conn.commit()
        conn.close()
    
    def get_lessons(self, category=None, limit=10):
        """Get recent lessons, optionally filtered by category."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        if category:
            rows = conn.execute(
                'SELECT * FROM lessons WHERE category LIKE ? ORDER BY confidence DESC, timestamp DESC LIMIT ?',
                (f'%{category}%', limit)
            ).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM lessons ORDER BY confidence DESC, timestamp DESC LIMIT ?',
                (limit,)
            ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    
    def get_similar_actions(self, action_type, goal_keywords=None, limit=5):
        """Get past actions of the same type, optionally matching goal keywords."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        
        if goal_keywords:
            rows = conn.execute(
                '''SELECT * FROM actions 
                   WHERE action_type = ? AND goal LIKE ? 
                   ORDER BY timestamp DESC LIMIT ?''',
                (action_type, f'%{goal_keywords}%', limit)
            ).fetchall()
        else:
            rows = conn.execute(
                'SELECT * FROM actions WHERE action_type = ? ORDER BY timestamp DESC LIMIT ?',
                (action_type, limit)
            ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
    
    def get_success_rate(self, action_type=None, hours=24):
        """Get success rate for actions in the last N hours."""
        conn = sqlite3.connect(self.db_path)
        cutoff = time.time() - (hours * 3600)
        
        if action_type:
            total = conn.execute(
                'SELECT COUNT(*) FROM actions WHERE action_type=? AND timestamp>?',
                (action_type, cutoff)
            ).fetchone()[0]
            successes = conn.execute(
                'SELECT COUNT(*) FROM actions WHERE action_type=? AND success=1 AND timestamp>?',
                (action_type, cutoff)
            ).fetchone()[0]
        else:
            total = conn.execute(
                'SELECT COUNT(*) FROM actions WHERE timestamp>?', (cutoff,)
            ).fetchone()[0]
            successes = conn.execute(
                'SELECT COUNT(*) FROM actions WHERE success=1 AND timestamp>?', (cutoff,)
            ).fetchone()[0]
        
        conn.close()
        return {
            'total': total,
            'successes': successes,
            'failures': total - successes,
            'rate': round(successes / total * 100, 1) if total > 0 else 0,
        }
    
    def get_context_for_goal(self, goal, limit=5):
        """Get relevant past experience for a similar goal.
        Returns a formatted string the LLM can use as context."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        
        # Find sessions with similar goals
        keywords = goal.lower().split()
        conditions = ' OR '.join(['goal LIKE ?' for _ in keywords])
        params = [f'%{kw}%' for kw in keywords]
        
        sessions = conn.execute(
            f'''SELECT * FROM sessions 
                WHERE {conditions}
                ORDER BY start_time DESC LIMIT ?''',
            params + [limit]
        ).fetchall()
        
        if not sessions:
            conn.close()
            return "No past experience with similar goals."
        
        context_parts = []
        for session in sessions:
            s = dict(session)
            status = "✅ succeeded" if s['success'] else "❌ failed"
            steps = s.get('total_steps', '?')
            dt = datetime.fromtimestamp(s['start_time']).strftime('%Y-%m-%d %H:%M')
            context_parts.append(
                f"- [{dt}] Goal: \"{s['goal']}\" → {status} in {steps} steps. {s.get('final_result', '')}"
            )
        
        # Get relevant lessons
        lessons = self.get_lessons(limit=3)
        if lessons:
            context_parts.append("\nLessons learned:")
            for l in lessons:
                context_parts.append(f"  - [{l['category']}] {l['lesson']}")
        
        conn.close()
        return '\n'.join(context_parts)
    
    def get_stats(self):
        """Get overall memory stats."""
        conn = sqlite3.connect(self.db_path)
        
        total_actions = conn.execute('SELECT COUNT(*) FROM actions').fetchone()[0]
        total_sessions = conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0]
        total_lessons = conn.execute('SELECT COUNT(*) FROM lessons').fetchone()[0]
        
        # Recent success rate
        rate = self.get_success_rate(hours=24)
        
        # Most common action types
        action_types = conn.execute(
            'SELECT action_type, COUNT(*) as cnt FROM actions GROUP BY action_type ORDER BY cnt DESC LIMIT 5'
        ).fetchall()
        
        conn.close()
        
        return {
            'total_actions': total_actions,
            'total_sessions': total_sessions,
            'total_lessons': total_lessons,
            'success_rate_24h': rate,
            'common_actions': [{'type': r[0], 'count': r[1]} for r in action_types],
            'db_path': self.db_path,
        }


# Global singleton
_memory = None

def get_memory():
    """Get the global ActionMemory singleton."""
    global _memory
    if _memory is None:
        _memory = ActionMemory()
    return _memory


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='JetArm Action Memory')
    parser.add_argument('--stats', action='store_true', help='Show memory stats')
    parser.add_argument('--lessons', action='store_true', help='Show lessons learned')
    parser.add_argument('--history', type=int, default=0, help='Show last N actions')
    args = parser.parse_args()
    
    memory = ActionMemory()
    
    if args.stats:
        stats = memory.get_stats()
        print(json.dumps(stats, indent=2))
    elif args.lessons:
        lessons = memory.get_lessons(limit=20)
        for l in lessons:
            print(f"  [{l['category']}] {l['lesson']} (confidence: {l['confidence']})")
    elif args.history > 0:
        conn = sqlite3.connect(MEMORY_DB)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            'SELECT * FROM actions ORDER BY timestamp DESC LIMIT ?', (args.history,)
        ).fetchall()
        for r in rows:
            d = dict(r)
            status = '✅' if d['success'] else '❌'
            print(f"  {status} Step {d['step']}: {d['action_type']} → {d['result'][:80]}")
        conn.close()
    else:
        stats = memory.get_stats()
        print(f"📊 JetArm Memory: {stats['total_actions']} actions, {stats['total_sessions']} sessions, {stats['total_lessons']} lessons")
        print(f"   Success rate (24h): {stats['success_rate_24h']['rate']}%")
        print(f"   DB: {stats['db_path']}")
