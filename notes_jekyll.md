# Notes for learning Jekyll

`jekyll new myblog` will create a bundle in the folder `myblog` including essential components for building a static website.
`cd myblog`
`bundle exec jekyll serve` to launch the website on the server.


`_config.yml` can be used to adjust the template for the website, so one can change the title and description for the desired needs.

`jekyll build` to build the webpage.
`jekyll serve --livereload` to actively update the webpage based on the updates.

## Liquid
`Objects` use `{{ page.title }}`
`Tags` use `{%  %}`
`Filters` use `{{ "Hi" | capitalize }}` to filter the text and make it lowercase as specified.

Most of those markdown files need to be in the root folder to make sure the sites are generated successfully!

`bundle update` to install required packages each time when they are added to the `_config.yml` in the plugins section.

`JEKYLL_ENV=production bundle exec jekyll build` to launch the website in production environment, then copy contents from `_site` to github.
`jekyll new PATH` create a new site with default `Gemfile`.


---

## Posts

##### To get the post listed on the page.
```
<ul>
  {% for post in site.posts %}
    <li>
      <a href="{{ post.url }}">{{ post.title }}</a>
    </li>
  {% endfor %}
</ul>
```

`excerpt` can be used to get a snippet of a post.
`excerpt_separator: <!--more-->` to define the `<!--more-->` to be the end of the excerpt, next just put `<!--more-->` at the end of the text that I wish to have to include in.

## Front Matter
`layout: null` will remove all the layout.
`published: false` to hide some content.
`jekyll serve --unpublished --draft` to see contents that are hidden and in draft folder.
`{{page.customized}}` to show customized variables on the same page.


## Collections
- #TODO: do not understand, please double check
read more on the colelctions part.


## Permalinks






I stopped at `Collections`, need to understand that. 
