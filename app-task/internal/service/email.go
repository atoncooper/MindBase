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

type quizEmailData struct {
	Question       string
	QuestionType   string
	Options        []string
	AnswerDeadline string
}

type overdueEmailData struct {
	Message string
	Prompt  string
}

// EnqueueQuizEmail renders the quiz email HTML and enqueues a pending notification.
func EnqueueQuizEmail(taskID, recipient string, ccEmails []string, quiz map[string]any, deadlineStr string) error {
	html, err := renderTemplate("template/quiz_email.html", quizEmailData{
		Question:       latexToText(str(quiz["question"])),
		QuestionType:   str(quiz["question_type"]),
		Options:        latexToTextSlice(toStringSlice(quiz["options"])),
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
