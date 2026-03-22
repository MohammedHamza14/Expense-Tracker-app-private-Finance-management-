// ============================================================
// Analytics.jsx
// Expense Analytics page with modular vanilla JS functions.
//
// ALL analytics logic is written as pure vanilla JavaScript
// utility functions (no framework dependency). The React
// component at the bottom is a thin wrapper that wires
// these functions into the existing app.
//
// Dependencies:
//   - Firebase Firestore (data source)
//   - Chart.js (already in package.json)
//   - Tailwind CSS (styling)
// ============================================================

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { Chart, registerables } from "chart.js";

Chart.register(...registerables);

// ╔══════════════════════════════════════════════════════════════╗
// ║          SECTION 1 — PURE VANILLA JS UTILITY FUNCTIONS      ║
// ║   No React. No Firebase. Just plain JavaScript.             ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── Constants ────────────────────────────────────────────────

/** Category → color mapping used across charts and UI */
const CATEGORY_COLORS = {
    Food: "#f87171",
    Transport: "#60a5fa",
    Shopping: "#fbbf24",
    Health: "#34d399",
    Entertainment: "#a78bfa",
    Bills: "#fb923c",
    Travel: "#f472b6",
    Other: "#94a3b8",
};

/** Fallback color for unknown categories */
const DEFAULT_COLOR = "#94a3b8";

/** Day labels for weekly charts (Sunday-first to match JS Date.getDay()) */
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short month names for trend charts */
const MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ─── Formatting helper ───────────────────────────────────────

/**
 * Format a number as INR currency.
 * Change locale / currency for your region.
 * @param {number} n - Amount to format
 * @returns {string} Formatted currency string
 */
function fmt(n) {
    return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
        maximumFractionDigits: 0,
    }).format(n ?? 0);
}

// ─── 1. getMonthlyReport(expenses) ───────────────────────────

/**
 * Filter expenses for the current calendar month, calculate
 * the total, and group by category.
 *
 * @param {Array<{id:string, amount:number, category:string, date:string}>} expenses
 * @returns {{
 *   month: number,
 *   year: number,
 *   total: number,
 *   count: number,
 *   categoryBreakdown: Object<string, number>,
 *   expenses: Array
 * }}
 */
function getMonthlyReport(expenses) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed

    // Filter expenses that fall in the current month
    const filtered = expenses.filter((e) => {
        const d = new Date(e.date);
        return d.getFullYear() === year && d.getMonth() === month;
    });

    // Calculate total spending
    const total = filtered.reduce((sum, e) => sum + (e.amount || 0), 0);

    // Group by category → { Food: 1500, Transport: 800, ... }
    const categoryBreakdown = getCategoryTotals(filtered);

    return {
        month,
        year,
        total,
        count: filtered.length,
        categoryBreakdown,
        expenses: filtered,
    };
}

// ─── 2. getWeeklyReport(expenses) ────────────────────────────

/**
 * Filter expenses for the current week (Sunday → Saturday),
 * calculate total, and provide a day-by-day breakdown.
 *
 * @param {Array<{id:string, amount:number, category:string, date:string}>} expenses
 * @returns {{
 *   total: number,
 *   count: number,
 *   dailyBreakdown: number[],   // 7 elements [Sun, Mon, ..., Sat]
 *   weekStart: Date,
 *   weekEnd: Date,
 *   expenses: Array
 * }}
 */
function getWeeklyReport(expenses) {
    const now = new Date();

    // Find Sunday (start of week)
    const dayOfWeek = now.getDay(); // 0 = Sun
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - dayOfWeek);
    weekStart.setHours(0, 0, 0, 0);

    // Find Saturday (end of week)
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // Filter expenses within this week
    const filtered = expenses.filter((e) => {
        const d = new Date(e.date);
        return d >= weekStart && d <= weekEnd;
    });

    // Build daily breakdown array: index 0 = Sun, 6 = Sat
    const dailyBreakdown = Array(7).fill(0);
    filtered.forEach((e) => {
        const dayIdx = new Date(e.date).getDay();
        dailyBreakdown[dayIdx] += e.amount || 0;
    });

    const total = dailyBreakdown.reduce((a, b) => a + b, 0);

    return {
        total,
        count: filtered.length,
        dailyBreakdown,
        weekStart,
        weekEnd,
        expenses: filtered,
    };
}

// ─── 3. getCategoryTotals(expenses) ──────────────────────────

/**
 * Group expenses by category and sum amounts.
 *
 * @param {Array<{id:string, amount:number, category:string, date:string}>} expenses
 * @returns {Object<string, number>}  e.g. { Food: 2500, Transport: 1200 }
 */
function getCategoryTotals(expenses) {
    return expenses.reduce((acc, e) => {
        const cat = e.category || "Other";
        acc[cat] = (acc[cat] || 0) + (e.amount || 0);
        return acc;
    }, {});
}

// ─── 4. getTrendData(expenses, months) ───────────────────────

/**
 * Compare spending across the last N months.
 * Returns monthly totals and percentage changes between
 * consecutive months, plus a simple trend indicator.
 *
 * @param {Array<{id:string, amount:number, category:string, date:string}>} expenses
 * @param {number} [months=6] - Number of past months to compare
 * @returns {{
 *   months: Array<{month:number, year:number, label:string, total:number}>,
 *   changes: Array<{pct:number|null, direction:string}>,
 *   overallTrend: string
 * }}
 */
function getTrendData(expenses, months = 6) {
    const now = new Date();
    const result = [];

    // Build totals for each of the last `months` months
    for (let i = months - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const year = d.getFullYear();
        const month = d.getMonth();

        // Sum expenses for this month
        const total = expenses
            .filter((e) => {
                const ed = new Date(e.date);
                return ed.getFullYear() === year && ed.getMonth() === month;
            })
            .reduce((sum, e) => sum + (e.amount || 0), 0);

        result.push({
            month,
            year,
            label: `${MONTH_NAMES[month]} ${year}`,
            total,
        });
    }

    // Calculate percentage change between consecutive months
    const changes = [];
    for (let i = 1; i < result.length; i++) {
        const prev = result[i - 1].total;
        const curr = result[i].total;

        if (prev === 0) {
            changes.push({ pct: curr > 0 ? 100 : 0, direction: curr > 0 ? "up" : "flat" });
        } else {
            const pct = ((curr - prev) / prev) * 100;
            const direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
            changes.push({ pct: Math.round(pct * 10) / 10, direction });
        }
    }

    // Overall trend: compare first and last month
    let overallTrend = "flat";
    if (result.length >= 2) {
        const first = result[0].total;
        const last = result[result.length - 1].total;
        if (last > first) overallTrend = "up";
        else if (last < first) overallTrend = "down";
    }

    return { months: result, changes, overallTrend };
}

// ╔══════════════════════════════════════════════════════════════╗
// ║          SECTION 2 — CHART.JS RENDERING FUNCTIONS           ║
// ║   Vanilla JS — accepts a canvas element and data.           ║
// ╚══════════════════════════════════════════════════════════════╝

/**
 * Render (or re-render) a Doughnut/Pie chart on a canvas element.
 * Returns the Chart instance so it can be destroyed later.
 *
 * @param {HTMLCanvasElement} canvasEl - Target canvas
 * @param {Object<string, number>} categoryData - { Food: 2500, ... }
 * @param {Chart|null} existingChart - Previous instance to destroy
 * @returns {Chart} The new Chart.js instance
 */
function renderPieChart(canvasEl, categoryData, existingChart = null) {
    // Destroy old chart if it exists (prevents "Canvas already in use" error)
    if (existingChart) {
        existingChart.destroy();
    }

    const labels = Object.keys(categoryData);
    const values = Object.values(categoryData);
    const colors = labels.map((l) => CATEGORY_COLORS[l] || DEFAULT_COLOR);

    return new Chart(canvasEl, {
        type: "doughnut",
        data: {
            labels,
            datasets: [
                {
                    data: values,
                    backgroundColor: colors,
                    borderColor: "#0f172a",
                    borderWidth: 2,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "62%",
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const total = values.reduce((a, b) => a + b, 0);
                            const pct = ((ctx.raw / total) * 100).toFixed(1);
                            return ` ${fmt(ctx.raw)}  (${pct}%)`;
                        },
                    },
                },
            },
        },
    });
}

/**
 * Render (or re-render) a Bar chart showing daily spending.
 *
 * @param {HTMLCanvasElement} canvasEl - Target canvas
 * @param {number[]} dayTotals - Array of 7 numbers [Sun..Sat]
 * @param {Chart|null} existingChart - Previous instance to destroy
 * @returns {Chart} The new Chart.js instance
 */
function renderBarChart(canvasEl, dayTotals, existingChart = null) {
    if (existingChart) {
        existingChart.destroy();
    }

    const todayIdx = new Date().getDay();

    return new Chart(canvasEl, {
        type: "bar",
        data: {
            labels: DAY_LABELS,
            datasets: [
                {
                    label: "Spending",
                    data: dayTotals,
                    backgroundColor: dayTotals.map((_, i) =>
                        i === todayIdx ? "#60a5fa" : "#1e3a5f"
                    ),
                    borderRadius: 6,
                    borderSkipped: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: (ctx) => ` ${fmt(ctx.raw)}` },
                },
            },
            scales: {
                x: {
                    ticks: { color: "#94a3b8", font: { size: 12 } },
                    grid: { display: false },
                },
                y: {
                    ticks: {
                        color: "#94a3b8",
                        font: { size: 11 },
                        callback: (v) =>
                            "₹" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
                    },
                    grid: { color: "rgba(148,163,184,0.08)" },
                },
            },
        },
    });
}

/**
 * Render a trend line chart showing monthly spending over time.
 *
 * @param {HTMLCanvasElement} canvasEl - Target canvas
 * @param {Array<{label:string, total:number}>} monthlyData - From getTrendData().months
 * @param {Chart|null} existingChart - Previous instance to destroy
 * @returns {Chart} The new Chart.js instance
 */
function renderTrendChart(canvasEl, monthlyData, existingChart = null) {
    if (existingChart) {
        existingChart.destroy();
    }

    return new Chart(canvasEl, {
        type: "line",
        data: {
            labels: monthlyData.map((m) => m.label),
            datasets: [
                {
                    label: "Monthly Spending",
                    data: monthlyData.map((m) => m.total),
                    borderColor: "#60a5fa",
                    backgroundColor: "rgba(96, 165, 250, 0.1)",
                    borderWidth: 2,
                    pointBackgroundColor: "#60a5fa",
                    pointBorderColor: "#0f172a",
                    pointBorderWidth: 2,
                    pointRadius: 5,
                    tension: 0.3,
                    fill: true,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: (ctx) => ` ${fmt(ctx.raw)}` },
                },
            },
            scales: {
                x: {
                    ticks: { color: "#94a3b8", font: { size: 11 } },
                    grid: { display: false },
                },
                y: {
                    ticks: {
                        color: "#94a3b8",
                        font: { size: 11 },
                        callback: (v) =>
                            "₹" + (v >= 1000 ? (v / 1000).toFixed(0) + "k" : v),
                    },
                    grid: { color: "rgba(148,163,184,0.08)" },
                },
            },
        },
    });
}

// ╔══════════════════════════════════════════════════════════════╗
// ║          SECTION 3 — REACT COMPONENT (THIN WRAPPER)         ║
// ║   Only responsible for Firebase fetch, state, and JSX.      ║
// ║   All logic delegates to the vanilla functions above.       ║
// ╚══════════════════════════════════════════════════════════════╝

// ─── Small UI sub-components ─────────────────────────────────

/** KPI stat card */
function StatCard({ label, value, sub, trendPct }) {
    const up = trendPct > 0;
    const neutral = trendPct == null;
    return (
        <div className="bg-slate-800 rounded-2xl p-5 flex flex-col gap-1 border border-slate-700">
            <span className="text-xs text-slate-400 tracking-wide uppercase">{label}</span>
            <span className="text-2xl font-semibold text-white">{value}</span>
            {sub && <span className="text-xs text-slate-500">{sub}</span>}
            {!neutral && (
                <span className={`text-xs font-medium mt-1 ${up ? "text-red-400" : "text-emerald-400"}`}>
                    {up ? "↑" : "↓"} {Math.abs(trendPct).toFixed(1)}% vs last month
                </span>
            )}
        </div>
    );
}

/** Category row in the breakdown list */
function CategoryRow({ name, amount, total }) {
    const pct = total > 0 ? (amount / total) * 100 : 0;
    const color = CATEGORY_COLORS[name] || DEFAULT_COLOR;
    return (
        <div className="flex items-center gap-3 py-2">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />
            <span className="text-sm text-slate-300 flex-1 truncate">{name}</span>
            <div className="w-24 bg-slate-700 rounded-full h-1.5 hidden sm:block">
                <div
                    className="h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: color }}
                />
            </div>
            <span className="text-xs text-slate-500 w-9 text-right">{pct.toFixed(0)}%</span>
            <span className="text-sm font-medium text-white w-20 text-right">{fmt(amount)}</span>
        </div>
    );
}

/** Section wrapper card */
function Section({ title, children, action }) {
    return (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-slate-300 tracking-wide uppercase">{title}</h2>
                {action}
            </div>
            {children}
        </div>
    );
}

/** Empty state placeholder */
function Empty({ message = "No expenses found for this period." }) {
    return (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-slate-500">
            <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round"
                    d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342
             1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375
             c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75
             c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125
             1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21
             a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375
             a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5l-3.719-3.719
             a1.5 1.5 0 00-2.121 0l-1.5 1.5" />
            </svg>
            <p className="text-sm">{message}</p>
        </div>
    );
}

/** Loading spinner */
function Loader() {
    return (
        <div className="flex items-center justify-center py-16">
            <svg className="animate-spin h-8 w-8 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
        </div>
    );
}

// ─── Main Analytics Component ─────────────────────────────────

export default function Analytics() {
    // ── Auth ──────────────────────────────────────────────────
    const { currentUser } = useAuth();

    // ── State ─────────────────────────────────────────────────
    const [expenses, setExpenses] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // ── Canvas refs for Chart.js ──────────────────────────────
    const pieCanvasRef = useRef(null);
    const barCanvasRef = useRef(null);
    const trendCanvasRef = useRef(null);
    const pieChartRef = useRef(null);
    const barChartRef = useRef(null);
    const trendChartRef = useRef(null);

    // ── Fetch from Firestore ──────────────────────────────────
    useEffect(() => {
        if (!currentUser) return;

        const fetchExpenses = async () => {
            setLoading(true);
            setError(null);
            try {
                const q = query(
                    collection(db, "expenses"),
                    where("userId", "==", currentUser.uid)
                );
                const snapshot = await getDocs(q);
                const data = snapshot.docs.map((doc) => ({
                    id: doc.id,
                    ...doc.data(),
                }));
                setExpenses(data);
            } catch (err) {
                console.error("Analytics fetch error:", err);
                setError("Failed to load expense data. Please try again.");
            } finally {
                setLoading(false);
            }
        };

        fetchExpenses();
    }, [currentUser]);

    // ── Derived data using vanilla JS functions ───────────────
    const monthlyReport = useMemo(() => getMonthlyReport(expenses), [expenses]);
    const weeklyReport = useMemo(() => getWeeklyReport(expenses), [expenses]);
    const trendData = useMemo(() => getTrendData(expenses, 6), [expenses]);

    // Previous month total for comparison
    const prevMonthTotal = useMemo(() => {
        const now = new Date();
        const prevYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
        const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
        return expenses
            .filter((e) => {
                const d = new Date(e.date);
                return d.getFullYear() === prevYear && d.getMonth() === prevMonth;
            })
            .reduce((sum, e) => sum + (e.amount || 0), 0);
    }, [expenses]);

    // Trend percentage: current vs previous month
    const trendPct = useMemo(() => {
        if (prevMonthTotal === 0) return null;
        return ((monthlyReport.total - prevMonthTotal) / prevMonthTotal) * 100;
    }, [monthlyReport.total, prevMonthTotal]);

    // Sorted categories for display (highest first)
    const sortedCategories = useMemo(
        () => Object.entries(monthlyReport.categoryBreakdown).sort((a, b) => b[1] - a[1]),
        [monthlyReport.categoryBreakdown]
    );

    const now = new Date();

    // ── Chart rendering via vanilla JS functions ──────────────
    // Pie chart: category distribution
    useEffect(() => {
        if (!pieCanvasRef.current || sortedCategories.length === 0) return;
        pieChartRef.current = renderPieChart(
            pieCanvasRef.current,
            monthlyReport.categoryBreakdown,
            pieChartRef.current
        );
        return () => {
            if (pieChartRef.current) {
                pieChartRef.current.destroy();
                pieChartRef.current = null;
            }
        };
    }, [monthlyReport.categoryBreakdown, sortedCategories.length]);

    // Bar chart: weekly daily breakdown
    useEffect(() => {
        if (!barCanvasRef.current || weeklyReport.total === 0) return;
        barChartRef.current = renderBarChart(
            barCanvasRef.current,
            weeklyReport.dailyBreakdown,
            barChartRef.current
        );
        return () => {
            if (barChartRef.current) {
                barChartRef.current.destroy();
                barChartRef.current = null;
            }
        };
    }, [weeklyReport.dailyBreakdown, weeklyReport.total]);

    // Line chart: monthly trend
    useEffect(() => {
        if (!trendCanvasRef.current || trendData.months.length === 0) return;
        trendChartRef.current = renderTrendChart(
            trendCanvasRef.current,
            trendData.months,
            trendChartRef.current
        );
        return () => {
            if (trendChartRef.current) {
                trendChartRef.current.destroy();
                trendChartRef.current = null;
            }
        };
    }, [trendData.months]);

    // ── Render ────────────────────────────────────────────────
    if (!currentUser) {
        return (
            <div className="min-h-screen bg-slate-950 flex items-center justify-center">
                <p className="text-slate-400">Please log in to view analytics.</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-950 text-white px-4 py-8 sm:px-6 lg:px-10">

            {/* ── Page Header ── */}
            <div className="mb-8">
                <h1 className="text-2xl font-bold text-white tracking-tight">
                    Expense Analytics
                </h1>
                <p className="text-sm text-slate-500 mt-1">
                    {now.toLocaleString("default", { month: "long", year: "numeric" })} · your spending overview
                </p>
            </div>

            {/* ── Error Banner ── */}
            {error && (
                <div className="mb-6 bg-red-900/40 border border-red-700 text-red-300 text-sm rounded-xl px-4 py-3">
                    {error}
                </div>
            )}

            {/* ── Loading ── */}
            {loading ? (
                <Loader />
            ) : (
                <div className="grid gap-6">

                    {/* ── Row 1: KPI Stat Cards ── */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <StatCard
                            label="This Month"
                            value={fmt(monthlyReport.total)}
                            sub={`${monthlyReport.count} transactions`}
                            trendPct={trendPct}
                        />
                        <StatCard
                            label="Last Month"
                            value={fmt(prevMonthTotal)}
                            sub={`previous period`}
                        />
                        <StatCard
                            label="This Week"
                            value={fmt(weeklyReport.total)}
                            sub="Sun – Sat"
                        />
                        <StatCard
                            label="Daily Average"
                            value={fmt(monthlyReport.total / (now.getDate() || 1))}
                            sub="this month"
                        />
                    </div>

                    {/* ── Row 2: Monthly Report — Category Breakdown + Pie Chart ── */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                        {/* Category List */}
                        <Section title="Monthly Report — Category Breakdown">
                            {sortedCategories.length === 0 ? (
                                <Empty />
                            ) : (
                                <div className="divide-y divide-slate-800">
                                    {sortedCategories.map(([name, amount]) => (
                                        <CategoryRow
                                            key={name}
                                            name={name}
                                            amount={amount}
                                            total={monthlyReport.total}
                                        />
                                    ))}
                                </div>
                            )}
                        </Section>

                        {/* Pie / Doughnut Chart */}
                        <Section title="Category Distribution">
                            {sortedCategories.length === 0 ? (
                                <Empty />
                            ) : (
                                <>
                                    <div className="relative" style={{ height: 220 }}>
                                        <canvas ref={pieCanvasRef} />
                                    </div>
                                    {/* Custom legend */}
                                    <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 justify-center">
                                        {sortedCategories.map(([name]) => (
                                            <span key={name} className="flex items-center gap-1.5 text-xs text-slate-400">
                                                <span
                                                    className="w-2 h-2 rounded-sm"
                                                    style={{ background: CATEGORY_COLORS[name] || DEFAULT_COLOR }}
                                                />
                                                {name}
                                            </span>
                                        ))}
                                    </div>
                                </>
                            )}
                        </Section>
                    </div>

                    {/* ── Row 3: Weekly Report — Bar Chart ── */}
                    <Section
                        title="Weekly Report"
                        action={
                            <span className="text-xs text-slate-500">
                                Total: <span className="text-white font-medium">{fmt(weeklyReport.total)}</span>
                            </span>
                        }
                    >
                        {weeklyReport.total === 0 ? (
                            <Empty message="No spending recorded this week." />
                        ) : (
                            <div className="relative" style={{ height: 200 }}>
                                <canvas ref={barCanvasRef} />
                            </div>
                        )}

                        {/* Day-by-day summary below chart */}
                        <div className="grid grid-cols-7 gap-1 mt-4">
                            {DAY_LABELS.map((day, i) => {
                                const isToday = i === now.getDay();
                                return (
                                    <div
                                        key={day}
                                        className={`text-center rounded-lg py-2 px-1
                      ${isToday ? "bg-blue-900/40 ring-1 ring-blue-700" : "bg-slate-800"}`}
                                    >
                                        <p className={`text-xs mb-1 ${isToday ? "text-blue-400" : "text-slate-500"}`}>
                                            {day}
                                        </p>
                                        <p className="text-xs font-medium text-white truncate">
                                            {weeklyReport.dailyBreakdown[i] > 0
                                                ? "₹" + (weeklyReport.dailyBreakdown[i] >= 1000
                                                    ? (weeklyReport.dailyBreakdown[i] / 1000).toFixed(1) + "k"
                                                    : weeklyReport.dailyBreakdown[i].toFixed(0))
                                                : "—"}
                                        </p>
                                    </div>
                                );
                            })}
                        </div>
                    </Section>

                    {/* ── Row 4: Expense Trends (last 6 months) ── */}
                    <Section title="Expense Trends (Last 6 Months)">
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                            {/* Trend line chart */}
                            <div>
                                <div className="relative" style={{ height: 220 }}>
                                    <canvas ref={trendCanvasRef} />
                                </div>
                            </div>

                            {/* Trend details */}
                            <div className="flex flex-col gap-4">
                                {/* Overall trend indicator */}
                                <div className="flex items-center gap-4">
                                    <div
                                        className={`text-4xl font-bold ${trendPct == null
                                            ? "text-slate-500"
                                            : trendPct > 0
                                                ? "text-red-400"
                                                : "text-emerald-400"
                                            }`}
                                    >
                                        {trendPct == null
                                            ? "—"
                                            : (trendPct > 0 ? "↑ " : "↓ ") + Math.abs(trendPct).toFixed(1) + "%"}
                                    </div>
                                    <div className="text-sm text-slate-400 leading-relaxed">
                                        {trendPct == null ? (
                                            "No data for last month."
                                        ) : trendPct > 0 ? (
                                            <>Spending is <span className="text-red-400 font-medium">higher</span> than last month</>
                                        ) : (
                                            <>Spending is <span className="text-emerald-400 font-medium">lower</span> than last month</>
                                        )}
                                    </div>
                                </div>

                                {/* Monthly breakdown pills */}
                                <div className="flex gap-2 flex-wrap">
                                    {trendData.months.map((m, i) => {
                                        const change = trendData.changes[i - 1]; // changes[0] = between month 0→1
                                        return (
                                            <div key={m.label} className="bg-slate-800 rounded-xl px-3 py-2 text-center min-w-[80px]">
                                                <p className="text-xs text-slate-500 mb-1">{m.label}</p>
                                                <p className="text-sm font-semibold text-white">{fmt(m.total)}</p>
                                                {change && (
                                                    <p className={`text-xs mt-0.5 ${change.direction === "up" ? "text-red-400" : change.direction === "down" ? "text-emerald-400" : "text-slate-500"
                                                        }`}>
                                                        {change.direction === "up" ? "↑" : change.direction === "down" ? "↓" : "—"} {Math.abs(change.pct)}%
                                                    </p>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Comparison pills */}
                                <div className="flex gap-3 flex-wrap">
                                    <div className="bg-slate-800 rounded-xl px-4 py-2 text-center min-w-[100px]">
                                        <p className="text-xs text-slate-500 mb-1">This month</p>
                                        <p className="text-sm font-semibold text-white">{fmt(monthlyReport.total)}</p>
                                    </div>
                                    <div className="bg-slate-800 rounded-xl px-4 py-2 text-center min-w-[100px]">
                                        <p className="text-xs text-slate-500 mb-1">Last month</p>
                                        <p className="text-sm font-semibold text-white">{fmt(prevMonthTotal)}</p>
                                    </div>
                                    <div
                                        className={`rounded-xl px-4 py-2 text-center min-w-[100px] ${trendPct == null ? "bg-slate-800"
                                            : trendPct > 0 ? "bg-red-900/30"
                                                : "bg-emerald-900/30"
                                            }`}
                                    >
                                        <p className="text-xs text-slate-500 mb-1">Difference</p>
                                        <p className={`text-sm font-semibold ${trendPct == null ? "text-slate-400"
                                            : trendPct > 0 ? "text-red-400"
                                                : "text-emerald-400"
                                            }`}>
                                            {fmt(Math.abs(monthlyReport.total - prevMonthTotal))}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </Section>

                </div>
            )}
        </div>
    );
}
