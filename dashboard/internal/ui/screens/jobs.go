package screens

import (
	"fmt"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// JobsClosedMsg is emitted when the jobs screen is dismissed.
type JobsClosedMsg struct{}

// JobsOpenURLMsg requests opening a job URL in the browser.
type JobsOpenURLMsg struct{ URL string }

// JobsUpdateStatusMsg requests writing a new status for a job.
type JobsUpdateStatusMsg struct {
	CareerOpsPath string
	Job           model.Job
	NewStatus     string
}

// JobsRefreshMsg requests reloading jobs.md from disk.
type JobsRefreshMsg struct{}

const (
	jobsSortDate    = "date"
	jobsSortCompany = "company"
	jobsSortStatus  = "status"
)

type jobsTab struct {
	filter string
	label  string
}

var jobsTabs = []jobsTab{
	{"all", "ALL"},
	{"new", "NEW"},
	{"applied", "APPLIED"},
	{"interview", "INTERVIEW"},
	{"offer", "OFFER"},
	{"responded", "RESPONDED"},
	{"skip", "SKIP"},
	{"rejected", "REJECTED"},
	{"discarded", "DISCARDED"},
}

var jobsSortCycle = []string{jobsSortDate, jobsSortCompany, jobsSortStatus}

var jobStatusOptions = []string{"", "Applied", "SKIP", "Responded", "Interview", "Offer", "Rejected", "Discarded"}

// jobStatusGroupOrder controls display order for grouped view and metrics bar.
var jobStatusGroupOrder = []string{"interview", "offer", "responded", "applied", "evaluated", "new", "skip", "rejected", "discarded"}

// quickStatusKeys maps a single letter to a canonical status label.
var quickStatusKeys = map[string]string{
	"a": "Applied",
	"s": "SKIP",
	"r": "Responded",
	"i": "Interview",
	"o": "Offer",
	"x": "Rejected",
	"d": "Discarded",
}

// JobsModel implements the jobs tracker screen.
type JobsModel struct {
	jobs          []model.Job
	filtered      []model.Job
	metrics       model.JobsMetrics
	cursor        int
	scrollOffset  int
	sortMode      string
	activeTab     int
	viewMode      string // "grouped" or "flat"
	width, height int
	theme         theme.Theme
	careerOpsPath string
	statusPicker  bool
	statusCursor  int
	flash         string // transient feedback text in help bar
}

// NewJobsModel constructs a new jobs screen.
func NewJobsModel(t theme.Theme, jobs []model.Job, metrics model.JobsMetrics, careerOpsPath string, width, height int) JobsModel {
	m := JobsModel{
		jobs:          jobs,
		metrics:       metrics,
		sortMode:      jobsSortDate,
		activeTab:     0,
		viewMode:      "flat",
		width:         width,
		height:        height,
		theme:         t,
		careerOpsPath: careerOpsPath,
	}
	m.applyFilterAndSort()
	return m
}

// Init implements tea.Model.
func (m JobsModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *JobsModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

func (m JobsModel) Width() int  { return m.width }
func (m JobsModel) Height() int { return m.height }

// WithReloadedData rebuilds the screen from fresh data, preserving selection.
func (m JobsModel) WithReloadedData(jobs []model.Job, metrics model.JobsMetrics) JobsModel {
	selectedRaw := ""
	if j, ok := m.CurrentJob(); ok {
		selectedRaw = j.RawLine
	}

	reloaded := NewJobsModel(m.theme, jobs, metrics, m.careerOpsPath, m.width, m.height)
	reloaded.sortMode = m.sortMode
	reloaded.activeTab = m.activeTab
	reloaded.viewMode = m.viewMode
	reloaded.applyFilterAndSort()

	for i, j := range reloaded.filtered {
		if j.RawLine == selectedRaw {
			reloaded.cursor = i
			reloaded.adjustScroll()
			return reloaded
		}
	}
	if len(reloaded.filtered) == 0 {
		return reloaded
	}
	if m.cursor >= len(reloaded.filtered) {
		reloaded.cursor = len(reloaded.filtered) - 1
	} else if m.cursor > 0 {
		reloaded.cursor = m.cursor
	}
	reloaded.adjustScroll()
	return reloaded
}

// CurrentJob returns the currently highlighted job.
func (m JobsModel) CurrentJob() (model.Job, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.Job{}, false
	}
	return m.filtered[m.cursor], true
}

// Update handles input.
func (m JobsModel) Update(msg tea.Msg) (JobsModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	}
	return m, nil
}

func (m JobsModel) handleKey(msg tea.KeyMsg) (JobsModel, tea.Cmd) {
	key := msg.String()

	// Quick-status shortcuts first (before single-letter nav handlers)
	if label, ok := quickStatusKeys[key]; ok {
		if job, ok := m.CurrentJob(); ok {
			m.flash = fmt.Sprintf("→ %s", label)
			path := m.careerOpsPath
			jobRef := job
			return m, func() tea.Msg {
				return JobsUpdateStatusMsg{CareerOpsPath: path, Job: jobRef, NewStatus: label}
			}
		}
		return m, nil
	}

	switch key {
	case "q", "esc":
		return m, func() tea.Msg { return JobsClosedMsg{} }

	case "down", "j":
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
		}

	case "up", "k":
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
		}

	case "right", "l":
		m.activeTab = (m.activeTab + 1) % len(jobsTabs)
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "left", "h":
		m.activeTab--
		if m.activeTab < 0 {
			m.activeTab = len(jobsTabs) - 1
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "tab":
		for i, s := range jobsSortCycle {
			if s == m.sortMode {
				m.sortMode = jobsSortCycle[(i+1)%len(jobsSortCycle)]
				break
			}
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "v":
		if m.viewMode == "grouped" {
			m.viewMode = "flat"
		} else {
			m.viewMode = "grouped"
		}
		m.applyFilterAndSort()

	case "enter", "u":
		if job, ok := m.CurrentJob(); ok && job.URL != "" {
			url := job.URL
			return m, func() tea.Msg { return JobsOpenURLMsg{URL: url} }
		}

	case "ctrl+r":
		return m, func() tea.Msg { return JobsRefreshMsg{} }

	case "c":
		if len(m.filtered) > 0 {
			m.statusPicker = true
			m.statusCursor = 0
		}

	case " ", "backspace":
		// Clear status back to blank ("new")
		if job, ok := m.CurrentJob(); ok {
			m.flash = "→ cleared"
			path := m.careerOpsPath
			jobRef := job
			return m, func() tea.Msg {
				return JobsUpdateStatusMsg{CareerOpsPath: path, Job: jobRef, NewStatus: ""}
			}
		}

	case "g":
		if len(m.filtered) > 0 {
			m.cursor = 0
			m.scrollOffset = 0
		}

	case "G":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
		}

	case "pgdown", "ctrl+d":
		if len(m.filtered) > 0 {
			half := m.height / 2
			if half < 1 {
				half = 1
			}
			m.cursor += half
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
		}

	case "pgup", "ctrl+u":
		if len(m.filtered) > 0 {
			half := m.height / 2
			if half < 1 {
				half = 1
			}
			m.cursor -= half
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
		}
	}

	return m, nil
}

func (m JobsModel) handleStatusPicker(msg tea.KeyMsg) (JobsModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
	case "down", "j":
		m.statusCursor++
		if m.statusCursor >= len(jobStatusOptions) {
			m.statusCursor = len(jobStatusOptions) - 1
		}
	case "up", "k":
		m.statusCursor--
		if m.statusCursor < 0 {
			m.statusCursor = 0
		}
	case "enter":
		m.statusPicker = false
		if job, ok := m.CurrentJob(); ok {
			newStatus := jobStatusOptions[m.statusCursor]
			label := newStatus
			if label == "" {
				label = "cleared"
			}
			m.flash = "→ " + label
			path := m.careerOpsPath
			jobRef := job
			return m, func() tea.Msg {
				return JobsUpdateStatusMsg{CareerOpsPath: path, Job: jobRef, NewStatus: newStatus}
			}
		}
	}
	return m, nil
}

// applyFilterAndSort rebuilds the filtered slice from jobs.
func (m *JobsModel) applyFilterAndSort() {
	currentFilter := jobsTabs[m.activeTab].filter
	var filtered []model.Job
	for _, j := range m.jobs {
		norm := data.NormalizeJobStatus(j.Status)
		if currentFilter == "all" || norm == currentFilter {
			filtered = append(filtered, j)
		}
	}

	switch m.sortMode {
	case jobsSortDate:
		sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].Date > filtered[j].Date })
	case jobsSortCompany:
		sort.SliceStable(filtered, func(i, j int) bool {
			return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
		})
	case jobsSortStatus:
		sort.SliceStable(filtered, func(i, j int) bool {
			return jobStatusPriority(filtered[i].Status) < jobStatusPriority(filtered[j].Status)
		})
	}

	if m.viewMode == "grouped" {
		sort.SliceStable(filtered, func(i, j int) bool {
			pi := jobStatusPriority(filtered[i].Status)
			pj := jobStatusPriority(filtered[j].Status)
			if pi != pj {
				return pi < pj
			}
			switch m.sortMode {
			case jobsSortCompany:
				return strings.ToLower(filtered[i].Company) < strings.ToLower(filtered[j].Company)
			default:
				return filtered[i].Date > filtered[j].Date
			}
		})
	}

	m.filtered = filtered
}

func (m *JobsModel) adjustScroll() {
	avail := m.height - 10 // header + tabs(2) + metrics + sortbar + help + 1 buffer
	if avail < 5 {
		avail = 5
	}
	line := m.cursorLineEstimate()
	margin := 3
	if line >= m.scrollOffset+avail-margin {
		m.scrollOffset = line - avail + margin + 1
	}
	if line < m.scrollOffset+margin {
		m.scrollOffset = line - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m JobsModel) cursorLineEstimate() int {
	if m.viewMode != "grouped" {
		return m.cursor
	}
	line := 0
	prev := ""
	for i, j := range m.filtered {
		norm := data.NormalizeJobStatus(j.Status)
		if norm != prev {
			line++
			prev = norm
		}
		if i == m.cursor {
			return line
		}
		line++
	}
	return line
}

// --- View ---

func (m JobsModel) View() string {
	header := m.renderHeader()
	tabs := m.renderTabs()
	metricsBar := m.renderMetrics()
	sortBar := m.renderSortBar()
	body := m.renderBody()
	help := m.renderHelp()

	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}
	avail := m.height - 6 // header + tabs(2) + metrics + sortbar + help
	if avail < 3 {
		avail = 3
	}
	if len(bodyLines) > avail {
		bodyLines = bodyLines[:avail]
	}
	body = strings.Join(bodyLines, "\n")

	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		tabs,
		metricsBar,
		sortBar,
		body,
		help,
	)
}

func (m JobsModel) renderHeader() string {
	style := lipgloss.NewStyle().
		Bold(true).
		Foreground(m.theme.Text).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Render("JOBS TRACKER")
	right := lipgloss.NewStyle().Foreground(m.theme.Subtext)
	newCount := m.metrics.ByStatus["new"]
	info := right.Render(fmt.Sprintf("%d jobs | %d new", m.metrics.Total, newCount))

	gap := m.width - lipgloss.Width(title) - lipgloss.Width(info) - 4
	if gap < 1 {
		gap = 1
	}
	return style.Render(title + strings.Repeat(" ", gap) + info)
}

func (m JobsModel) renderTabs() string {
	var tabs []string
	var unders []string
	for i, tab := range jobsTabs {
		count := m.countForFilter(tab.filter)
		label := fmt.Sprintf(" %s (%d) ", tab.label, count)
		if i == m.activeTab {
			s := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue)
			tabs = append(tabs, s.Render(label))
			unders = append(unders, strings.Repeat("━", lipgloss.Width(label)))
		} else {
			s := lipgloss.NewStyle().Foreground(m.theme.Subtext)
			tabs = append(tabs, s.Render(label))
			unders = append(unders, strings.Repeat("─", lipgloss.Width(label)))
		}
	}
	row := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	underline := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render(strings.Join(unders, ""))
	pad := lipgloss.NewStyle().Padding(0, 1)
	return pad.Render(row) + "\n" + pad.Render(underline)
}

func (m JobsModel) countForFilter(filter string) int {
	if filter == "all" {
		return len(m.jobs)
	}
	return m.metrics.ByStatus[filter]
}

func (m JobsModel) renderMetrics() string {
	style := lipgloss.NewStyle().
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 2)

	colors := m.statusColorMap()
	var parts []string
	for _, status := range jobStatusGroupOrder {
		count, ok := m.metrics.ByStatus[status]
		if !ok || count == 0 {
			continue
		}
		s := lipgloss.NewStyle().Foreground(colors[status])
		parts = append(parts, s.Render(fmt.Sprintf("%s:%d", jobStatusLabel(status), count)))
	}
	return style.Render(strings.Join(parts, "  "))
}

func (m JobsModel) renderSortBar() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Width(m.width).
		Padding(0, 2)

	sortLabel := fmt.Sprintf("[Sort: %s]", m.sortMode)
	viewLabel := fmt.Sprintf("[View: %s]", m.viewMode)
	count := fmt.Sprintf("%d shown", len(m.filtered))
	return style.Render(fmt.Sprintf("%s  %s  %s", sortLabel, viewLabel, count))
}

func (m JobsModel) renderBody() string {
	if len(m.filtered) == 0 {
		empty := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(1, 2)
		return empty.Render("No jobs match this filter")
	}

	var lines []string
	prev := ""
	pad := lipgloss.NewStyle().Padding(0, 2)

	for i, job := range m.filtered {
		norm := data.NormalizeJobStatus(job.Status)
		if m.viewMode == "grouped" && norm != prev {
			count := m.countByNorm(norm)
			hdr := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Subtext)
			fill := m.width - 30 - len(jobStatusLabel(norm))
			if fill < 0 {
				fill = 0
			}
			lines = append(lines, pad.Render(hdr.Render(
				fmt.Sprintf("── %s (%d) %s",
					strings.ToUpper(jobStatusLabel(norm)), count, strings.Repeat("─", fill)))))
			prev = norm
		}
		lines = append(lines, m.renderJobLine(job, i == m.cursor))
	}

	return strings.Join(lines, "\n")
}

func (m JobsModel) renderJobLine(job model.Job, selected bool) string {
	pad := lipgloss.NewStyle().Padding(0, 2)

	statusW := 10
	dateW := 11
	companyW := 18
	locW := 14
	roleW := m.width - statusW - dateW - companyW - locW - 12
	if roleW < 15 {
		roleW = 15
	}

	norm := data.NormalizeJobStatus(job.Status)
	statusColor := m.statusColorMap()[norm]
	statusStyle := lipgloss.NewStyle().Foreground(statusColor).Width(statusW)
	statusText := statusStyle.Render(truncateRunes(jobStatusLabel(norm), statusW))

	date := job.Date
	if date == "" {
		date = "—"
	}
	dateStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(dateW)

	companyStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(companyW)
	roleStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(roleW)
	locStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(locW)

	loc := job.Location
	if loc == "" {
		loc = "—"
	}

	line := fmt.Sprintf(" %s %s %s %s %s",
		statusText,
		dateStyle.Render(truncateRunes(date, dateW)),
		companyStyle.Render(truncateRunes(job.Company, companyW)),
		roleStyle.Render(truncateRunes(job.Role, roleW)),
		locStyle.Render(truncateRunes(loc, locW)),
	)

	if selected {
		sel := lipgloss.NewStyle().Background(m.theme.Overlay).Width(m.width - 4)
		return pad.Render(sel.Render(line))
	}
	return pad.Render(line)
}

func (m JobsModel) renderHelp() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	k := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text)
	d := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	if m.statusPicker {
		return style.Render(
			k.Render("↑↓/jk") + d.Render(" nav  ") +
				k.Render("Enter") + d.Render(" confirm  ") +
				k.Render("Esc") + d.Render(" cancel"))
	}

	keys := k.Render("↑↓") + d.Render(" nav  ") +
		k.Render("←→") + d.Render(" tabs  ") +
		k.Render("Tab") + d.Render(" sort  ") +
		k.Render("v") + d.Render(" view  ") +
		k.Render("Enter") + d.Render(" open  ") +
		k.Render("a/s/r/i/o/x/d") + d.Render(" status  ") +
		k.Render("␣") + d.Render(" clear  ") +
		k.Render("c") + d.Render(" pick  ") +
		k.Render("^R") + d.Render(" reload  ") +
		k.Render("q") + d.Render(" quit")

	right := ""
	if m.flash != "" {
		right = lipgloss.NewStyle().Foreground(m.theme.Green).Render(m.flash)
	}
	gap := m.width - lipgloss.Width(keys) - lipgloss.Width(right) - 2
	if gap < 1 {
		gap = 1
	}
	return style.Render(keys + strings.Repeat(" ", gap) + right)
}

func (m JobsModel) overlayStatusPicker(body string) string {
	lines := strings.Split(body, "\n")

	pickerWidth := 30
	pad := lipgloss.NewStyle().Padding(0, 2)
	border := lipgloss.NewStyle().Foreground(m.theme.Blue).Bold(true)

	picker := []string{pad.Render(border.Render("Change status:"))}
	for i, opt := range jobStatusOptions {
		label := opt
		if label == "" {
			label = "(clear)"
		}
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
		prefix := "  "
		if i == m.statusCursor {
			style = style.Background(m.theme.Overlay).Bold(true)
			prefix = "> "
		}
		picker = append(picker, pad.Render(style.Render(prefix+label)))
	}

	lines = append(lines, picker...)
	return strings.Join(lines, "\n")
}

// --- helpers ---

func (m JobsModel) statusColorMap() map[string]lipgloss.Color {
	return map[string]lipgloss.Color{
		"interview": m.theme.Green,
		"offer":     m.theme.Green,
		"responded": m.theme.Blue,
		"applied":   m.theme.Sky,
		"evaluated": m.theme.Yellow,
		"new":       m.theme.Text,
		"skip":      m.theme.Red,
		"rejected":  m.theme.Subtext,
		"discarded": m.theme.Subtext,
	}
}

func (m JobsModel) countByNorm(norm string) int {
	n := 0
	for _, j := range m.filtered {
		if data.NormalizeJobStatus(j.Status) == norm {
			n++
		}
	}
	return n
}

func jobStatusPriority(status string) int {
	switch data.NormalizeJobStatus(status) {
	case "interview":
		return 0
	case "offer":
		return 1
	case "responded":
		return 2
	case "applied":
		return 3
	case "evaluated":
		return 4
	case "new":
		return 5
	case "skip":
		return 6
	case "rejected":
		return 7
	case "discarded":
		return 8
	default:
		return 9
	}
}

func jobStatusLabel(norm string) string {
	switch norm {
	case "interview":
		return "Interview"
	case "offer":
		return "Offer"
	case "responded":
		return "Responded"
	case "applied":
		return "Applied"
	case "evaluated":
		return "Evaluated"
	case "new":
		return "New"
	case "skip":
		return "SKIP"
	case "rejected":
		return "Rejected"
	case "discarded":
		return "Discarded"
	default:
		return norm
	}
}
