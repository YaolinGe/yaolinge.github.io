#!/bin/bash

# Ask the user for a commit message
echo "Enter your commit message:"
read commit_message

# Add all changes to git
git add .

# Commit the changes with the provided message
git commit -m "$commit_message"

# Push the changes to the remote repository
git push --all

echo "Changes have been pushed to the remote repository."