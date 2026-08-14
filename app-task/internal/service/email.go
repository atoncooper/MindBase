package service

import (
	"embed"
	"fmt"
	"html/template"
	"path/filepath"
	"strings"

	"app-task/internal/model"
	"app-task/internal/repo"

	"github.com/google/uuid"
)

//go:embed template/*.html template/*.txt
var templateFS embed.FS

type quizEmailQuestion struct {
	Index        int // 1-based
	Question     string
	QuestionType string
	Options      []string
}

type quizEmailData struct {
	Count          int
	ShowDetail     bool // 题数 <= 2 时邮件内联展示题目；否则只显示数量
	Prompt         string
	Questions      []quizEmailQuestion
	AnswerDeadline string
}

type overdueEmailData struct {
	Message string
	Prompt  string
}

// EnqueueQuizEmail renders the quiz email HTML and enqueues a pending notification.
// 多题策略：≤2 道在邮件里内联展示具体题目；>2 道只提示"共 N 道题，请登录系统查看"，
// 避免邮件过长。
func EnqueueQuizEmail(taskID, recipient string, ccEmails []string, prompt string, questions []QuizQuestion, deadlineStr string) error {
	showDetail := len(questions) <= 2
	qs := make([]quizEmailQuestion, 0, len(questions))
	for i, q := range questions {
		qs = append(qs, quizEmailQuestion{
			Index:        i + 1,
			Question:     latexToText(q.Question),
			QuestionType: q.QuestionType,
			Options:      latexToTextSlice(q.Options),
		})
	}
	html, err := renderTemplate("template/quiz_email.html", quizEmailData{
		Count:          len(questions),
		ShowDetail:     showDetail,
		Prompt:         prompt,
		Questions:      qs,
		AnswerDeadline: deadlineStr,
	})
	if err != nil {
		return err
	}
	return enqueue(taskID, "quiz_email", recipient, ccEmails, "【MindBase】您的定时出题任务", html)
}

// EnqueueOverdueEmail renders the overdue email and enqueues a pending notification.
func EnqueueOverdueEmail(taskID, recipient string, ccEmails []string, incompleteMessage, prompt string) error {
	body := incompleteMessage
	if body == "" {
		body = defaultIncomplete()
	}
	html, err := renderTemplate("template/overdue_email.html", overdueEmailData{
		Message: body,
		Prompt:  prompt,
	})
	if err != nil {
		return err
	}
	return enqueue(taskID, "overdue_email", recipient, ccEmails, "【MindBase】出题任务未完成提醒", html)
}

func enqueue(taskID, typ, recipient string, ccEmails []string, subject, bodyHTML string) error {
	notificationID := uuid.NewString()
	n := &model.TaskQuizNotification{
		NotificationID: notificationID,
		TaskID:         taskID,
		Type:           typ,
		Recipient:      recipient,
		CCEmails:       toJSON(ccEmails),
		Subject:        subject,
		BodyHTML:       bodyHTML,
		Status:         "pending",
	}
	if err := repo.CreateNotification(n); err != nil {
		return fmt.Errorf("create notification: %w", err)
	}
	return nil
}

func renderTemplate(name string, data any) (string, error) {
	t, err := template.New(filepath.Base(name)).ParseFS(templateFS, name)
	if err != nil {
		return "", fmt.Errorf("parse %s: %w", name, err)
	}
	var sb strings.Builder
	if err := t.Execute(&sb, data); err != nil {
		return "", fmt.Errorf("execute %s: %w", name, err)
	}
	return sb.String(), nil
}

func defaultIncomplete() string {
	b, err := templateFS.ReadFile("template/incomplete_default.txt")
	if err != nil {
		return "您有一项定时出题任务未在规定时间内完成。"
	}
	return strings.TrimSpace(string(b))
}
