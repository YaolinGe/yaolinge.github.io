# Notes for learning Jekyll
!!! Every time after I have modified `_config.yml` file, then I need to restart
the server.
!!! `baseurl=/Blog` does not have `/` in the end
!!! `link: /Blog/` then needs to have it in the end in `navigation.yml`.

# To launch it the very first time
- `bundle exec jekyll serve --livereload --draft` to launch it with draft included.

# To change theme
- go to `rubygems.org` and search `jekyll-theme` and then find suitable themes.
- go to `Gemfile` add `gem "jekyll-theme-hacker"`.
- go to terminal, run `bundle install`.
- update `_config.yml` with new updated theme.
- can go to the github repo and checkout what `layout` this theme has, and then use that layout.

# To add new layout
- create `_layouts`
- create `_layouts/post.html`
- layout can take advantage of other wrapper layout as the basis, and the build on top of that, one can have more flexible choices on the specific layout in each case.

# To use conditionals
- use `{% if page.url == post.url %} color:red; {% endif %}` to change the color of the style.

# To add space gap
- `<br>` is a line break.

# To add front matter in static files
- go to `_config.yml` and change it over there.

# To push it on github pages
- remember to build the site locally first before pushing them online.
- `git checkout -b gh-pages` to create a separate branch for `Github Pages`.
- `git push origin gh-pages` to push all files to the remote branch `gh-pages`.






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

## Custom sorting

- Automatically ordering
```
collections:
  tutorials:
    sort_by: lesson
```
- manually ordering
```
collections:
  tutorials:
    order:
      - hello-world.md
      - introduction.md
      - basic-concepts.md
      - advanced-concepts.md
      - concepts/basics.md
      - concepts/advanced.md
```


## Assets




I stopped at `Collections`, need to understand that.
